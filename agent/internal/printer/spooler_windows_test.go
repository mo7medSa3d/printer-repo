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

func TestBoundedPreflightSingleFlightRefusesOverlap(t *testing.T) {
	p := &SpoolerPrinter{Name: "T", SpoolerName: "wedged_spooler_singleflight"}
	block := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- p.boundedPreflight(context.Background(), 300*time.Millisecond, func() error {
			<-block // wedged RPC: never returns until released
			return nil
		})
	}()
	// Let the first call register its in-flight helper.
	time.Sleep(50 * time.Millisecond)

	// A second overlapping call must fail FAST, not spawn another helper
	// that would accumulate behind the wedged RPC.
	start := time.Now()
	err := p.boundedPreflight(context.Background(), 5*time.Second, func() error { return nil })
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("overlapping preflight must be refused while one is stuck")
	}
	if !errors.Is(err, ErrPrinterNotReady) {
		t.Fatalf("refusal must stay a typed not-ready failure, got %v", err)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("refusal was not fast: waited %v", elapsed)
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("pre-dispatch refusal must not be classified unknown: %v", err)
	}

	// Once the wedged RPC finally returns, the flag clears and the next
	// call proceeds normally: recovery is automatic, no restart required.
	// (The helper holds the flag until ITS check returns, not until the
	// bounded caller gives up - otherwise every timeout would leak one more
	// stuck helper behind the wedged RPC.)
	close(block)
	<-done
	err = p.boundedPreflight(context.Background(), 2*time.Second, func() error { return nil })
	if err != nil {
		t.Fatalf("recovered spooler must accept preflight again, got %v", err)
	}
}

func TestSpoolerSessionTryLockRefusesOverlap(t *testing.T) {
	p := &SpoolerPrinter{Name: "T", SpoolerName: "session_mutex_test"}
	if err := p.tryBeginSession(); err != nil {
		t.Fatalf("first session must acquire the slot, got %v", err)
	}
	start := time.Now()
	err := p.tryBeginSession()
	elapsed := time.Since(start)
	if err == nil {
		p.endSession()
		t.Fatal("overlapping session must be refused while one is in progress")
	}
	if !errors.Is(err, ErrPrinterNotReady) {
		t.Fatalf("refusal must stay a typed not-ready failure, got %v", err)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("refusal was not fast: waited %v", elapsed)
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("pre-dispatch refusal must not be classified unknown: %v", err)
	}
	p.endSession()
	if err := p.tryBeginSession(); err != nil {
		t.Fatalf("slot must be reusable after the session ends, got %v", err)
	}
	p.endSession()
}

func TestSpoolerStatusUnknownPrinterIsOffline(t *testing.T) {
	// No such queue exists on any Windows host, so OpenPrinterW reliably
	// fails and the probe must report offline — never a bare-open "online".
	p := &SpoolerPrinter{
		Name:        "T",
		SpoolerName: "definitely-not-a-real-printer-4f2a9c",
		Timeout:     10 * time.Second,
	}
	if st := p.Status(); st != "offline" {
		t.Fatalf("unknown spooler queue must report offline, got %q", st)
	}
}
