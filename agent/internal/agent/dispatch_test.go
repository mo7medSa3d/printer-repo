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
func TestDispatchDeduplicatesInFlightJobs(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "p1", p)

	ag.dispatchJob(context.Background(), dispatchTestJob("dup_ws_poll", "p1"))
	ag.dispatchJob(context.Background(), dispatchTestJob("dup_ws_poll", "p1"))

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

	if elapsed > 10*time.Second {
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
