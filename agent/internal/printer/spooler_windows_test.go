//go:build windows

package printer

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The preflight check runs synchronously against Win32 spooler RPC, which has
// no deadline of its own. These tests prove the caller-side bound of
// runPreflightBounded using injected checks (no real spooler involved).
func TestPreflightBoundedSlowCheckPassesThrough(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	err := runPreflightBounded("slow-ok", 2*time.Second, ctx, func() error {
		time.Sleep(50 * time.Millisecond)
		return nil
	})
	if err != nil {
		t.Fatalf("slow-but-healthy check must pass through, got %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("healthy check took too long: %v", time.Since(start))
	}
}

func TestPreflightBoundedStuckCheckTimesOutFailClosed(t *testing.T) {
	block := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	err := runPreflightBounded("wedged-spooler", 150*time.Millisecond, ctx, func() error {
		<-block // simulates OpenPrinterW wedged on a dead spooler RPC
		return nil
	})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("stuck readiness check must fail, not hang")
	}
	if !errors.Is(err, ErrPrinterNotReady) {
		t.Fatalf("timeout must stay a typed not-ready failure, got %v", err)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("caller was not bounded: waited %v", elapsed)
	}
	// A timeout is provably pre-dispatch (status queries spool nothing), so
	// it must NOT carry an unknown-outcome marker.
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("preflight timeout must not be classified unknown: %v", err)
	}
	close(block)
}

func TestPreflightBoundedCancelledContextReturnsFast(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	block := make(chan struct{})
	defer close(block)
	start := time.Now()
	err := runPreflightBounded("cancelled", 5*time.Second, ctx, func() error {
		<-block
		return nil
	})
	if err == nil {
		t.Fatal("cancelled preflight must fail")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("cancelled caller was not bounded: waited %v", time.Since(start))
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("pre-dispatch cancellation must not be classified unknown: %v", err)
	}
}

func TestPreflightBoundedPropagatesCheckFailure(t *testing.T) {
	want := errors.New("boom")
	err := runPreflightBounded("failing", time.Second, context.Background(), func() error { return want })
	if !errors.Is(err, want) {
		t.Fatalf("check failure must pass through unchanged, got %v", err)
	}
}
