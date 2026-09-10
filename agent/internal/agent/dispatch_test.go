package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/odoo-print-agent/agent/internal/config"
	"github.com/odoo-print-agent/agent/internal/printer"
)

// TestRedeliveryAdoptsLiveClaimTokenForReports proves the full loop of the
// WS-send/evidence-loss race on the agent side:
//
//  1. delivery #1 (token A) reaches the printer and parks mid-print;
//  2. the Gateway (after a lost delivered_at write + release) re-claims and
//     redelivers the SAME job under token B while A is still executing;
//  3. the duplicate must NOT cause a second physical write;
//  4. keep-alive bookkeeping and the terminal report must switch to token B,
//     otherwise the gateway fences them away and a real printed result
//     strands as an unknown outcome.
func TestRedeliveryAdoptsLiveClaimTokenForReports(t *testing.T) {
	var mu sync.Mutex
	var patches []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/jobs" && r.Method == http.MethodPatch {
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			patches = append(patches, body)
			mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = srv.URL
	ag, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer ag.Close()
	p := &fakePrinter{blocked: make(chan struct{}), startedCh: make(chan string, 1)}
	ag.printers = map[string]printer.Printer{"p1": p}
	ag.printerConfigs = map[string]config.PrinterConfig{"p1": {ID: "p1", Name: "Test", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"}}

	first := dispatchTestJob("reclaim_token_race", "p1")
	first["claimToken"] = "tok-A"
	ag.dispatchJob(context.Background(), first)
	select {
	case <-p.startedCh:
	case <-time.After(10 * time.Second):
		t.Fatal("first print never reached the device")
	}

	// The "printing" report happened under the live token at the time (A).
	mu.Lock()
	sawPrintingA := false
	for _, b := range patches {
		if b["status"] == "printing" && b["claimToken"] == "tok-A" {
			sawPrintingA = true
		}
	}
	mu.Unlock()
	if !sawPrintingA {
		t.Fatal("expected a printing report fenced with tok-A before redelivery")
	}

	second := dispatchTestJob("reclaim_token_race", "p1")
	second["claimToken"] = "tok-B"
	receivedBefore := ag.deliveryReceivedAt("reclaim_token_race")
	time.Sleep(5 * time.Millisecond)
	ag.dispatchJob(context.Background(), second)

	// Bookkeeping must have adopted the live token for keep-alives.
	pairs := ag.inFlightJobIDs(64)
	if len(pairs) != 1 || pairs[0]["jobId"] != "reclaim_token_race" || pairs[0]["claimToken"] != "tok-B" {
		t.Fatalf("duplicate delivery must adopt the live claim token, got %v", pairs)
	}
	// And the delivery-received timestamp must move to the hand-off THIS
	// agent actually accepted last: the stale-claim safety window in
	// authorizeDispatchAfterReportFailure is judged against the CURRENT
	// envelope, not the superseded one.
	if received := ag.deliveryReceivedAt("reclaim_token_race"); !received.After(receivedBefore) {
		t.Fatalf("redelivery must refresh the delivery-received timestamp (before=%v after=%v)", receivedBefore, received)
	}

	close(p.blocked)
	ag.waitForJobs()

	if got := p.callsByJob["reclaim_token_race"]; got != 1 {
		t.Fatalf("redelivered in-flight job must physically print exactly once, got %d", got)
	}
	mu.Lock()
	defer mu.Unlock()
	var successToken interface{}
	var sawSuccess bool
	for _, b := range patches {
		if b["jobId"] == "reclaim_token_race" && b["status"] == "success" {
			successToken = b["claimToken"]
			sawSuccess = true
		}
	}
	if !sawSuccess {
		t.Fatal("no terminal success report was sent")
	}
	if successToken != "tok-B" {
		t.Fatalf("terminal report must carry the gateway's CURRENT token tok-B, got %v", successToken)
	}
}

func dispatchTestJob(id, printerID string) map[string]interface{} {
	return map[string]interface{}{
		"id":        id,
		"printerId": printerID,
		"payload":   makeJobPayload(id),
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	}
}

// The gateway delivers the same job over WS and the poll fallback; while the
// first copy is still printing, the second delivery must be dropped instead
// of queueing another print.
//
// The first print is kept provably in-flight when the duplicate arrives:
// fakePrinter parks on `blocked` once it has signalled `startedCh`, so the
// test genuinely exercises the in-flight dedup layer without depending on
// wall-clock pacing (which flakes on loaded Windows CI runners). Without this
// barrier the first job can finish before the second delivery is considered
// and the in-flight path is never actually exercised.
func TestDispatchDeduplicatesInFlightJobs(t *testing.T) {
	p := &fakePrinter{
		blocked:   make(chan struct{}),
		startedCh: make(chan string, 1),
	}
	ag := newTestAgent(t, "p1", p)

	ag.dispatchJob(context.Background(), dispatchTestJob("dup_ws_poll", "p1"))

	select {
	case <-p.startedCh:
		// First copy is now physically printing and parked on `blocked`.
	case <-time.After(10 * time.Second):
		t.Fatal("first print never started")
	}

	// Second delivery of the same job arrives while the first is in flight:
	// it MUST be dropped by dispatchJob's in-flight dedup immediately.
	ag.dispatchJob(context.Background(), dispatchTestJob("dup_ws_poll", "p1"))

	close(p.blocked) // release the first print

	ag.waitForJobs()
	if p.calls != 1 {
		t.Fatalf("expected exactly 1 print for duplicate deliveries, got %d", p.calls)
	}
}

// PHASE 3 (mandatory): a job physically delivered over WebSocket whose
// Gateway-side delivered_at evidence write LOST is requeued and redelivered
// under a FRESH claim token. If the agent is still executing the first
// delivery, the second (differently-tokened) envelope must NOT produce a
// second physical write. This is the exact race the gateway's
// releaseUndeliveredClaim path can trigger, proven end-to-end on the agent
// side with a counting transport: physical dispatch is at-most-once.
func TestDuplicateDeliveryWithFreshClaimTokenDoesNotReprint(t *testing.T) {
	p := &fakePrinter{
		blocked:   make(chan struct{}),
		startedCh: make(chan string, 1),
	}
	ag := newTestAgent(t, "p1", p)

	// First delivery, claim token A; it parks mid-print.
	first := dispatchTestJob("evidence_loss_race", "p1")
	first["claimToken"] = "token-A"
	ag.dispatchJob(context.Background(), first)
	select {
	case <-p.startedCh:
	case <-time.After(10 * time.Second):
		t.Fatal("first print never started")
	}

	// Redelivery with a DIFFERENT token (the reclaim that follows a lost
	// evidence write). Same job id.
	second := dispatchTestJob("evidence_loss_race", "p1")
	second["claimToken"] = "token-B"
	ag.dispatchJob(context.Background(), second)

	close(p.blocked) // release the first print
	ag.waitForJobs()

	if got := p.callsByJob["evidence_loss_race"]; got != 1 {
		t.Fatalf("redelivery with a fresh claim token must NOT reprint: physical writes=%d, want 1", got)
	}
}

// A burst of jobs must execute completely (bounded executor) and be fully
// drained by waitForJobs during shutdown.
func TestDispatchBoundedAndDrained(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "p1", p)

	const n = 12
	for i := 0; i < n; i++ {
		ag.dispatchJob(context.Background(), dispatchTestJob(
			"burst_"+string(rune('a'+i)), "p1"))
	}

	start := time.Now()
	ag.waitForJobs()
	elapsed := time.Since(start)

	// The real invariant is "all jobs drained well below the 25s shutdown
	// grace". The exact wall-clock figure is load-proportional (SQLite temp
	// DBs + loopback HTTP on 2-vCPU Windows runners), so keep 20s as a safety
	// bound instead of a house number — a drain that is merely slow must not
	// fail the build.
	if elapsed > 20*time.Second {
		t.Fatalf("drain took unexpectedly long: %v", elapsed)
	}
	if p.calls != n {
		t.Fatalf("expected %d prints, got %d", n, p.calls)
	}
}

// After beginShutdown, dispatchJob must refuse new work entirely.
func TestDispatchRejectsAfterShutdown(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "p1", p)

	ag.beginShutdown()
	ag.dispatchJob(context.Background(), dispatchTestJob("late_job", "p1"))

	start := time.Now()
	ag.waitForJobs()
	if time.Since(start) > 2*time.Second {
		t.Fatalf("waitForJobs should return immediately with no accepted jobs")
	}
	if p.calls != 0 {
		t.Fatalf("job dispatched after shutdown must not print, got %d calls", p.calls)
	}
}

// TestWaitForJobsNeverBlocksShutdownForever locks the documented shutdown
// contract: Run/Stop must return after at most shutdownGrace even when a
// worker is wedged (e.g. a spooler post-cancel wait that outruns the grace,
// or a detached PDF budget). The bounded return is what makes service stop
// safe together with crash recovery: surviving writes land, missed ones are
// recovered honestly as interrupted/unknown on restart. This must keep
// passing if anyone touches the grace, the wait, or the close ordering.
func TestWaitForJobsNeverBlocksShutdownForever(t *testing.T) {
	ag := newTestAgent(t, "p1", &fakePrinter{})
	ag.wg.Add(1) // simulate a handler that never returns (wedged syscall)
	start := time.Now()
	ag.waitForJobs()
	elapsed := time.Since(start)
	if elapsed < shutdownGrace {
		t.Fatalf("waitForJobs returned after %v, before the %v grace - in-flight work was not awaited", elapsed, shutdownGrace)
	}
	if elapsed > shutdownGrace+15*time.Second {
		t.Fatalf("waitForJobs blocked %v, beyond the %v grace + margin - shutdown is not bounded", elapsed, shutdownGrace)
	}
	if err := ag.Close(); err != nil {
		t.Fatalf("Close after bounded wait must succeed: %v", err)
	}
}
