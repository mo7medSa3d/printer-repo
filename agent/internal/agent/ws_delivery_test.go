package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/odoo-print-agent/agent/internal/config"
	"github.com/odoo-print-agent/agent/internal/printer"
	"github.com/odoo-print-agent/agent/internal/queue"
)

type statusUpdate struct {
	JobID      string `json:"jobId"`
	Status     string `json:"status"`
	Error      string `json:"error"`
	Reason     string `json:"reason"`
	ClaimToken string `json:"claimToken"`
}

type recordingGateway struct {
	mu        sync.Mutex
	updates   []statusUpdate
	acks      []string
	ackTokens map[string]string
	// rejectPrinting, when true, answers claimed->printing reports with the
	// exact fence rejection a real gateway emits for a superseded claim.
	// Tests the agent-side hard stop: zero bytes may follow such a response.
	rejectPrinting bool
	server         *httptest.Server
	sendCh         chan interface{}
}

func (g *recordingGateway) Updates() []statusUpdate {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]statusUpdate, len(g.updates))
	copy(out, g.updates)
	return out
}

func (g *recordingGateway) Acks() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]string, len(g.acks))
	copy(out, g.acks)
	return out
}

func (g *recordingGateway) AckTokens() map[string]string {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make(map[string]string, len(g.ackTokens))
	for k, v := range g.ackTokens {
		out[k] = v
	}
	return out
}

func newRecordingGateway(t *testing.T) *recordingGateway {
	t.Helper()
	g := &recordingGateway{sendCh: make(chan interface{}, 8)}
	upgrader := websocket.Upgrader{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/agent/jobs", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPatch:
			var body statusUpdate
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			g.mu.Lock()
			g.updates = append(g.updates, body)
			reject := g.rejectPrinting && body.Status == "printing"
			g.mu.Unlock()
			if reject {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"error":"Stale claim token: this attempt was superseded by a newer claim","code":"STALE_CLAIM","status":"claimed"}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true}`))
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[]`))
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/agent/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true}`))
	})
	mux.HandleFunc("/api/agent/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		done := make(chan struct{})
		go func() {
			defer close(done)
			for {
				_, msg, err := conn.ReadMessage()
				if err != nil {
					return
				}
				var frame map[string]string
				if err := json.Unmarshal(msg, &frame); err != nil {
					continue
				}
				if frame["type"] == "job_ack" {
					g.mu.Lock()
					g.acks = append(g.acks, frame["jobId"])
					if g.ackTokens == nil {
						g.ackTokens = make(map[string]string)
					}
					g.ackTokens[frame["jobId"]] = frame["claimToken"]
					g.mu.Unlock()
				}
			}
		}()
		for {
			select {
			case <-done:
				return
			case payload := <-g.sendCh:
				if err := conn.WriteJSON(payload); err != nil {
					return
				}
			case <-time.After(15 * time.Second):
				return
			}
		}
	})
	g.server = httptest.NewServer(mux)
	t.Cleanup(g.server.Close)
	return g
}

func newAgentAgainst(t *testing.T, serverURL, printerID string, p printer.Printer) *Agent {
	t.Helper()
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = serverURL
	no := false
	cfg.Agent.ReprintAfterCrash = &no
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ag.printers = map[string]printer.Printer{printerID: p}
	ag.printerConfigs = map[string]config.PrinterConfig{printerID: {ID: printerID, Name: "Test", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"}}
	t.Cleanup(func() {
		if err := ag.Close(); err != nil {
			t.Logf("Agent.Close: %v", err)
		}
	})
	return ag
}

func claimedEnvelope(jobID, printerID string) map[string]interface{} {
	return map[string]interface{}{
		"type": "print_job",
		"job": map[string]interface{}{
			"id":           jobID,
			"agentId":      "agt_test",
			"printerId":    printerID,
			"documentType": "receipt",
			"status":       "claimed",
			"payload":      makeJobPayload(jobID),
			"expiresAt":    time.Now().Add(time.Hour).Format(time.RFC3339),
			"retries":      0,
		},
		"id":        jobID,
		"printerId": printerID,
		"payload":   makeJobPayload(jobID),
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	}
}

func TestExtractJobFromWSMessage(t *testing.T) {
	env := claimedEnvelope("job_a", "p1")
	job, ok := extractJobFromWSMessage(env)
	if !ok || job["id"] != "job_a" || job["status"] != "claimed" {
		t.Fatalf("envelope job not extracted correctly: %v %v", job, ok)
	}
	legacy := map[string]interface{}{"id": "job_b", "printerId": "p1"}
	job, ok = extractJobFromWSMessage(legacy)
	if !ok || job["id"] != "job_b" {
		t.Fatalf("legacy bare job must still be accepted: %v %v", job, ok)
	}
	if _, ok := extractJobFromWSMessage(map[string]interface{}{"type": "something_else"}); ok {
		t.Fatal("unknown message types must be ignored")
	}
	if _, ok := extractJobFromWSMessage(map[string]interface{}{"type": "print_job"}); ok {
		t.Fatal("print_job without a job body must be ignored")
	}
}

func TestDuplicateWSDeliveryPrintsOnceAndAcksBoth(t *testing.T) {
	gw := newRecordingGateway(t)
	p := &fakePrinter{}
	ag := newAgentAgainst(t, gw.server.URL, "p1", p)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go ag.connectWebSocket(ctx)
	waitFor(t, 5*time.Second, func() bool { return ag.getWSConn() != nil })
	gw.sendCh <- claimedEnvelope("job_dup", "p1")
	waitFor(t, 5*time.Second, func() bool { return len(gw.Acks()) == 1 })
	waitForPrintStarted(t, p)
	ag.waitForJobs()
	gw.sendCh <- claimedEnvelope("job_dup", "p1")
	waitFor(t, 5*time.Second, func() bool { return len(gw.Acks()) == 2 })
	// No wait needed here: the duplicate takes dispatchJob's dedupe path,
	// which never calls wg.Add, and the handler is sequential, so the
	// observed second ack already proves the first delivery's Add is done.
	ag.waitForJobs()
	if p.calls != 1 {
		t.Fatalf("duplicate delivery must print exactly once, got %d prints", p.calls)
	}
	acks := gw.Acks()
	if len(acks) != 2 || acks[0] != "job_dup" || acks[1] != "job_dup" {
		t.Fatalf("both deliveries must be acknowledged, got %v", acks)
	}
	var successes int
	for _, u := range gw.Updates() {
		if u.JobID == "job_dup" && u.Status == "success" {
			successes++
		}
	}
	if successes < 2 {
		t.Fatalf("terminal result must be re-reported on duplicate delivery, got %d success updates", successes)
	}
}

func TestTerminalJobIsNotPrintedTwice(t *testing.T) {
	gw := newRecordingGateway(t)
	p := &fakePrinter{}
	ag := newAgentAgainst(t, gw.server.URL, "p1", p)
	ctx := context.Background()
	job := map[string]interface{}{
		"id":        "job_terminal",
		"printerId": "p1",
		"payload":   makeJobPayload("job_terminal"),
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	}
	ag.processJob(ctx, job)
	ag.processJob(ctx, job)
	if p.calls != 1 {
		t.Fatalf("terminal job must be printed exactly once, got %d", p.calls)
	}
}

func TestCapabilityMismatchIsReportedToGateway(t *testing.T) {
	gw := newRecordingGateway(t)
	p := &fakePrinter{}
	ag := newAgentAgainst(t, gw.server.URL, "p1", p)
	pdf := base64.StdEncoding.EncodeToString([]byte("%PDF-1.4\ntrailer<<>>\n%%EOF\n"))
	job := map[string]interface{}{
		"id":        "job_pdf_mismatch",
		"printerId": "p1",
		"payload":   map[string]interface{}{"type": "pdf", "encoding": "base64", "data": pdf},
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	}
	ag.processJob(context.Background(), job)
	if p.calls != 0 {
		t.Fatalf("incompatible payload must never be written to the printer, got %d prints", p.calls)
	}
	updates := gw.Updates()
	if len(updates) == 0 {
		t.Fatal("agent must report the capability failure to the gateway")
	}
	last := updates[len(updates)-1]
	if last.Status != "failed" || !strings.Contains(last.Error, "CAPABILITY_MISMATCH") {
		t.Fatalf("expected capability failure, got %#v", last)
	}
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met within timeout")
}

// waitForPrintStarted waits until the dispatched job's executor has entered
// the printer. The WS ack is sent BEFORE dispatchJob's wg.Add, so a test
// that only waits for the ack can reach waitForJobs (wg.Wait) while the
// handler goroutine has not yet called Add — sync.WaitGroup forbids Add
// concurrent with Wait, and the race detector fails the test (seen on the
// Windows CI runner). The print call happens strictly after Add, so
// observing it proves the Add is in the past and Wait is safe.
func waitForPrintStarted(t *testing.T, p *fakePrinter) {
	t.Helper()
	waitFor(t, 5*time.Second, func() bool { return p.Calls() >= 1 })
}

func TestInterruptedJobIsReportedAtStartup(t *testing.T) {
	gw := newRecordingGateway(t)
	p := &fakePrinter{}
	ag := newAgentAgainst(t, gw.server.URL, "p1", p)
	no := false
	ag.cfg.Agent.ReprintAfterCrash = &no
	if err := ag.queue.Push("job_crashed", "p1", []byte("bytes")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := ag.queue.UpdateStatus("job_crashed", "printing"); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	ag.recoverInterruptedJobs()
	updates := gw.Updates()
	if len(updates) != 1 {
		t.Fatalf("expected exactly one status report, got %#v", updates)
	}
	if updates[0].JobID != "job_crashed" || updates[0].Status != "failed" {
		t.Fatalf("unexpected report: %#v", updates[0])
	}
	if !strings.Contains(updates[0].Error, queue.InterruptedMarker) {
		t.Fatalf("report must carry the interruption marker, got %q", updates[0].Error)
	}
	if p.calls != 0 {
		t.Fatalf("startup recovery must never print, got %d prints", p.calls)
	}
}

func TestReprintAfterCrashPolicy(t *testing.T) {
	job := map[string]interface{}{
		"id":        "job_crashed",
		"printerId": "p1",
		"payload":   makeJobPayload("job_crashed"),
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	}

	t.Run("disabled: never reprints, reports the interruption", func(t *testing.T) {
		gw := newRecordingGateway(t)
		p := &fakePrinter{}
		ag := newAgentAgainst(t, gw.server.URL, "p1", p)
		no := false
		ag.cfg.Agent.ReprintAfterCrash = &no
		if err := ag.queue.Push("job_crashed", "p1", []byte("bytes")); err != nil {
			t.Fatalf("Push: %v", err)
		}
		if err := ag.queue.UpdateStatus("job_crashed", "printing"); err != nil {
			t.Fatalf("UpdateStatus: %v", err)
		}
		ag.recoverInterruptedJobs()
		ag.processJob(context.Background(), job)
		if p.calls != 0 {
			t.Fatalf("interrupted job must not be reprinted when the policy forbids it, got %d prints", p.calls)
		}
		updates := gw.Updates()
		last := updates[len(updates)-1]
		if last.Status != "failed" || !strings.Contains(last.Error, queue.InterruptedMarker) {
			t.Fatalf("expected a marked failure, got %#v", last)
		}
	})

	t.Run("explicit opt-in: reprints once and exposes at-least-once semantics", func(t *testing.T) {
		gw := newRecordingGateway(t)
		p := &fakePrinter{}
		ag := newAgentAgainst(t, gw.server.URL, "p1", p)
		yes := true
		ag.cfg.Agent.ReprintAfterCrash = &yes

		if !ag.cfg.ReprintAfterCrashEnabled() {
			t.Fatal("explicit true must enable at-least-once crash reprinting")
		}
		if err := ag.queue.Push("job_crashed", "p1", []byte("bytes")); err != nil {
			t.Fatalf("Push: %v", err)
		}
		if err := ag.queue.UpdateStatus("job_crashed", "printing"); err != nil {
			t.Fatalf("UpdateStatus: %v", err)
		}
		ag.recoverInterruptedJobs()
		ag.processJob(context.Background(), job)
		if p.calls != 1 {
			t.Fatalf("explicit crash-reprint opt-in should retry once in this test, got %d prints", p.calls)
		}
		last := gw.Updates()[len(gw.Updates())-1]
		if last.Status != "success" {
			t.Fatalf("expected the explicit opt-in retry to succeed, got %#v", last)
		}
	})

	t.Run("zero-value config: safe no-reprint default", func(t *testing.T) {
		gw := newRecordingGateway(t)
		p := &fakePrinter{}
		ag := newAgentAgainst(t, gw.server.URL, "p1", p)
		ag.cfg.Agent.ReprintAfterCrash = nil
		if ag.cfg.ReprintAfterCrashEnabled() {
			t.Fatal("nil crash-reprint policy must default to false")
		}
	})
}

func TestClaimTokenEchoedInStatusUpdatesAndAck(t *testing.T) {
	gw := newRecordingGateway(t)
	p := &fakePrinter{}
	ag := newAgentAgainst(t, gw.server.URL, "p1", p)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go ag.connectWebSocket(ctx)
	waitFor(t, 5*time.Second, func() bool { return ag.getWSConn() != nil })

	// The full chain: WS envelope carries the claim token, the agent echoes
	// it on every status report and on the ack frame.
	env := claimedEnvelope("job_with_token", "p1")
	env["job"].(map[string]interface{})["claimToken"] = "claim-live-123"
	gw.sendCh <- env
	waitFor(t, 5*time.Second, func() bool { return len(gw.Acks()) == 1 })
	waitForPrintStarted(t, p)
	ag.waitForJobs()

	if p.calls != 1 {
		t.Fatalf("expected exactly one print, got %d", p.calls)
	}
	seen := map[string]bool{}
	for _, u := range gw.Updates() {
		if u.JobID != "job_with_token" {
			continue
		}
		if u.ClaimToken != "claim-live-123" {
			t.Fatalf("status %q update is missing the echoed claim token: %+v", u.Status, u)
		}
		seen[u.Status] = true
	}
	if !seen["printing"] || !seen["success"] {
		t.Fatalf("expected fenced printing+success updates, got %+v", gw.Updates())
	}
	if tok := gw.AckTokens()["job_with_token"]; tok != "claim-live-123" {
		t.Fatalf("ack must carry the claim token, got %q", tok)
	}
}

func TestLedgerWriteFailureBlocksDispatch(t *testing.T) {
	gw := newRecordingGateway(t)
	p := &fakePrinter{}
	ag := newAgentAgainst(t, gw.server.URL, "p1", p)
	// Break the durable evidence base: no ledger row can ever be proven.
	if err := ag.queue.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	job := map[string]interface{}{
		"id":         "job_no_ledger",
		"printerId":  "p1",
		"payload":    makeJobPayload("job_no_ledger"),
		"expiresAt":  time.Now().Add(time.Hour).Format(time.RFC3339),
		"claimToken": "claim-ledger-x",
	}
	ag.processJob(context.Background(), job)
	ag.waitForJobs()
	if p.calls != 0 {
		t.Fatalf("dispatch without a writable ledger must print nothing, got %d prints", p.calls)
	}
	found := false
	for _, u := range gw.Updates() {
		if u.JobID == "job_no_ledger" && u.Status == "queued" {
			found = true
			// The unreachable local ledger turns into a FENCED pre-execution
			// return (reason ledger_unavailable), which the gateway maps to
			// a requeue carrying "Agent returned job before execution".
			if u.Reason != "ledger_unavailable" {
				t.Fatalf("expected the ledger_unavailable rejection reason, got %+v", u)
			}
			if u.ClaimToken != "claim-ledger-x" {
				t.Fatalf("fenced return must carry the claim token, got %+v", u)
			}
		}
	}
	if !found {
		t.Fatalf("expected a fenced queued return after ledger failure, got %+v", gw.Updates())
	}
}

func TestStalePrintingFenceHaltsBeforeHardware(t *testing.T) {
	// P0: the gateway rejects the claimed->printing transition (the claim
	// expired and was reassigned). processJob MUST NOT invoke the printer
	// backend at all: zero PrintDocument calls, zero bytes written.
	gw := newRecordingGateway(t)
	gw.rejectPrinting = true
	p := &fakePrinter{}
	ag := newAgentAgainst(t, gw.server.URL, "p1", p)
	job := map[string]interface{}{
		"id":         "job_stale_fence",
		"printerId":  "p1",
		"payload":    makeJobPayload("job_stale_fence"),
		"expiresAt":  time.Now().Add(time.Hour).Format(time.RFC3339),
		"claimToken": "claim-superseded-1",
	}
	ag.processJob(context.Background(), job)
	ag.waitForJobs()
	if p.calls != 0 {
		t.Fatalf("fence-rejected claim must never reach hardware, got %d printer calls", p.calls)
	}
	// The local ledger row must not be left 'printing': BeginPrint marked
	// it, the fence rejected it, and AbortPrint rolled it back - otherwise a
	// later restart would misread it as "may have printed" and block the
	// legitimate redelivery forever.
	_, status, found, err := ag.queue.Get("job_stale_fence")
	if err != nil {
		t.Fatalf("queue.Get: %v", err)
	}
	if !found {
		t.Fatalf("expected a rolled-back ledger row for the aborted attempt")
	}
	if status == "printing" {
		t.Fatalf("aborted attempt left the ledger in 'printing' - a restart would fake a crash-interrupt")
	}
	// And the stale token must have been cleared so recovery never reports
	// with it.
	if tok := ag.queue.ClaimTokenFor("job_stale_fence"); tok != "" {
		t.Fatalf("aborted attempt must clear the superseded claim token, got %q", tok)
	}
}

func TestUpdateJobStatusDetectsFenceRejection(t *testing.T) {
	gw := newRecordingGateway(t)
	gw.rejectPrinting = true
	p := &fakePrinter{}
	ag := newAgentAgainst(t, gw.server.URL, "p1", p)
	err := ag.updateJobStatus("job_x", "printing", "", "claim-dead")
	if err == nil {
		t.Fatalf("expected ErrStaleClaim, got nil")
	}
	if !errors.Is(err, ErrStaleClaim) {
		t.Fatalf("expected ErrStaleClaim, got %v", err)
	}
	// Non-fence statuses still report normally through the same path.
	gw.rejectPrinting = false
	if err := ag.updateJobStatus("job_x", "printing", "", "claim-live"); err != nil {
		t.Fatalf("expected nil error once the fence accepts, got %v", err)
	}
}
