package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
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

// Agent-side regression tests for the claim-before-delivery WebSocket
// protocol and for duplicate/terminal delivery handling (PART 1, steps B & D).

type statusUpdate struct {
	JobID  string `json:"jobId"`
	Status string `json:"status"`
	Error  string `json:"error"`
}

type recordingGateway struct {
	mu      sync.Mutex
	updates []statusUpdate
	acks    []string
	server  *httptest.Server
	sendCh  chan interface{}
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

// newRecordingGateway is a minimal stand-in for the gateway: it records agent
// PATCH status updates, upgrades /api/agent/ws and records job_ack frames.
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
			g.mu.Unlock()
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
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ag.printers = map[string]printer.Printer{printerID: p}
	ag.printerConfigs = map[string]config.PrinterConfig{printerID: {ID: printerID, Name: "Test", Type: "network", Endpoint: "127.0.0.1:9100"}}
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
			"id":            jobID,
			"branchId":      "branch_1",
			"agentId":       "agt_test",
			"printerId":     printerID,
			"destinationId": "dest_1",
			"documentType":  "receipt",
			"status":        "claimed",
			"payload":       makeJobPayload(jobID),
			"expiresAt":     time.Now().Add(time.Hour).Format(time.RFC3339),
			"retries":       0,
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
	if !ok {
		t.Fatal("delivery envelope must be understood")
	}
	if job["id"] != "job_a" || job["status"] != "claimed" {
		t.Fatalf("envelope job not extracted correctly: %v", job)
	}

	// Legacy bare job (older gateway build) still works.
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

// Test 4 (agent side): a duplicate WebSocket delivery is acknowledged but
// never printed twice.
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
	ag.waitForJobs()

	gw.sendCh <- claimedEnvelope("job_dup", "p1")
	waitFor(t, 5*time.Second, func() bool { return len(gw.Acks()) == 2 })
	ag.waitForJobs()

	if p.calls != 1 {
		t.Fatalf("duplicate delivery must print exactly once, got %d prints", p.calls)
	}
	acks := gw.Acks()
	if len(acks) != 2 || acks[0] != "job_dup" || acks[1] != "job_dup" {
		t.Fatalf("both deliveries must be acknowledged, got %v", acks)
	}

	// The second delivery must still report the existing terminal result, so
	// the gateway never waits for a status that will not come.
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

// Test 6 (agent side): a job that already reached a terminal state locally is
// never printed a second time, even when delivered again after a restart.
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

// A payload the printer cannot render must fail with CAPABILITY_MISMATCH and
// that failure must reach the gateway (never a silent downgrade to RAW).
func TestCapabilityMismatchIsReportedToGateway(t *testing.T) {
	gw := newRecordingGateway(t)
	p := &fakePrinter{} // byte-stream only: no PDF support
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
	if last.Status != "failed" {
		t.Fatalf("expected failed status, got %q", last.Status)
	}
	if !strings.Contains(last.Error, "CAPABILITY_MISMATCH") {
		t.Fatalf("failure reason must carry CAPABILITY_MISMATCH, got %q", last.Error)
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

// --- crash recovery (at-least-once made visible, NOT exactly-once) --------

// A job that was still printing when the agent stopped must be reported to the
// gateway as an explicit, marked failure when reprint_after_crash is disabled.
func TestInterruptedJobIsReportedAtStartup(t *testing.T) {
	gw := newRecordingGateway(t)
	p := &fakePrinter{}
	ag := newAgentAgainst(t, gw.server.URL, "p1", p)
	no := false
	ag.cfg.Agent.ReprintAfterCrash = &no

	// Simulate the previous process dying mid-print.
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

// With reprint_after_crash disabled the agent refuses to print an interrupted
// job again and re-reports the interruption; the default keeps the historical
// at-least-once behaviour (the job is printed again).
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

	t.Run("default: reprints (at-least-once, may duplicate paper)", func(t *testing.T) {
		gw := newRecordingGateway(t)
		p := &fakePrinter{}
		ag := newAgentAgainst(t, gw.server.URL, "p1", p)
		if !ag.cfg.ReprintAfterCrashEnabled() {
			t.Fatal("reprint_after_crash must default to true")
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
			t.Fatalf("default policy must retry the interrupted job exactly once here, got %d prints", p.calls)
		}
		last := gw.Updates()[len(gw.Updates())-1]
		if last.Status != "success" {
			t.Fatalf("expected the retry to succeed, got %#v", last)
		}
	})
}
