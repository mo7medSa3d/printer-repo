package agent

import (
	"context"
	"testing"
	"time"

	"github.com/odoo-print-agent/agent/internal/printer"
)

func TestRunBoundedDiscoveryReturnsBeforeUncancellableWorkerFinishes(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{})
	ctx := context.Background()

	start := time.Now()
	result, completed, finished := runBoundedDiscovery(ctx, 20*time.Millisecond, func(context.Context) printer.DiscoveryResult {
		close(started)
		<-release // simulate a synchronous Win32 call that ignores context cancellation
		return printer.DiscoveryResult{}
	})
	<-started
	if completed {
		t.Fatal("blocked discovery must not report completion")
	}
	if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
		t.Fatalf("bounded orchestration returned too slowly: %v", elapsed)
	}

	select {
	case <-finished:
		t.Fatal("uncancellable worker should still be running after orchestration timeout")
	default:
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("worker did not finish after release")
	}
	_ = result
}
