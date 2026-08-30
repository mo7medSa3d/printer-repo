package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/odoo-print-agent/agent/internal/printer"
	"github.com/odoo-print-agent/agent/internal/testutil"
)

// TestCrashWindowSimulation proves the honest duplicate window:
// bytes reach printer → agent would crash before PATCH success → gateway reclaims after lease.
// We simulate by ensuring mock captured bytes while agent queue would still be printing.
// Do NOT claim exactly-once; document at-least-once over socket during crash window.
func TestCrashWindowSimulation(t *testing.T) {
	mock := testutil.NewMockTCPPrinter("127.0.0.1:0")
	mock.Start()
	defer mock.Close()

	p := &printer.NetworkPrinter{Address: mock.Addr}
	ctx := context.Background()
	data := []byte("crash-window payload")

	// Step 1: bytes accepted (print succeeds at transport)
	if err := p.Print(ctx, data); err != nil {
		t.Fatalf("Print: %v", err)
	}
	caps := mock.WaitForCaptures(1, 5*time.Second)
	if len(caps) != 1 || string(caps[0]) != string(data) {
		t.Fatalf("capture failed %v", caps)
	}

	// Step 2: simulate crash before queue.UpdateStatus success + PATCH success
	// In real flow, gateway job is still `printing` with updatedAt = now, retries=0.
	// After 90s stale, gateway reclaims: next GET FOR UPDATE SKIP LOCKED will return same job with retries++.
	// Our simulation proves that if we re-print same id after crash, mock gets duplicate.
	if err := p.Print(ctx, data); err != nil {
		t.Fatalf("re-print after crash reclaim: %v", err)
	}
	caps2 := mock.WaitForCaptures(2, 5*time.Second)
	if len(caps2) != 2 {
		t.Fatalf("expected 2 captures after reclaim (duplicate), got %d", len(caps2))
	}
	// Document: both captures identical → duplicate physical print possible.
	if string(caps2[0]) != string(data) || string(caps2[1]) != string(data) {
		t.Fatalf("duplicate captures mismatch")
	}
}

func TestCrashWindowWithIdempotentSuccessGuard(t *testing.T) {
	// If agent had reached queue.UpdateStatus success before crash, second delivery should be suppressed via IsProcessed.
	// This test documents the guard: after success, duplicate Print should NOT happen.
	// Here we just prove mock alone has no guard — guard lives in queue.IsProcessed, not mock.
	mock := testutil.NewMockTCPPrinter("127.0.0.1:0")
	mock.Start()
	defer mock.Close()
	p := &printer.NetworkPrinter{Address: mock.Addr}
	ctx := context.Background()
	mockData := []byte("idempotent")
	p.Print(ctx, mockData)
	p.Print(ctx, mockData) // without queue guard, this WILL duplicate at wire level
	caps := mock.WaitForCaptures(2, 5*time.Second)
	if len(caps) != 2 {
		t.Fatalf("without queue guard, duplicate at wire level is 2, got %d", len(caps))
	}
	// Real agent would call IsProcessed(jobID) and skip second Print — see agent/agent_test.go TestDuplicateSkippedAfterSuccess
}
