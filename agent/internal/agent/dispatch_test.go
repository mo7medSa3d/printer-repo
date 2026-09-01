package agent

import (
	"context"
	"testing"
	"time"
)

func dispatchTestJob(id, printerID string) map[string]interface{} {
	return map[string]interface{}{
		"id":        id,
		"printerId": printerID,
		"payload": map[string]interface{}{
			"type": "raw", "encoding": "base64", "data": "aGVsbG8=", // "hello"
		},
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
