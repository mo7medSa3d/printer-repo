//go:build windows

package printer

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// The synchronous Win32 WriteFile has no deadline: once the call is in the
// kernel, context cancellation cannot interrupt it (documented Windows
// behavior). These tests prove the isolation MECHANISM around that fact —
// caller boundedness, honest outcome classification, and the wedge latch —
// using an injected write function. Behavior against real wedged hardware
// additionally requires a physical device stall, which CI cannot provide.

func TestUSBWriteCancelledBeforeDispatchIsPlain(t *testing.T) {
	p := &USBPrinter{ID: "u1", Name: "U1", DevicePath: "NUL"}
	called := &atomic.Int32{}
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		called.Add(1)
		return uint32(len(chunk)), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := p.Print(ctx, []byte("hello"))
	if err == nil {
		t.Fatal("pre-cancelled print must fail")
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("cancellation BEFORE any byte was queued is provably pre-dispatch and must stay plain: %v", err)
	}
	if called.Load() != 0 {
		t.Fatalf("no kernel write may start after cancellation: %d calls", called.Load())
	}
}

func TestUSBWritePartialThenErrorIsUnknown(t *testing.T) {
	p := &USBPrinter{ID: "u2", Name: "U2", DevicePath: "NUL"}
	calls := &atomic.Int32{}
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		if calls.Add(1) == 1 {
			return 3, nil // partial delivery of the first chunk
		}
		return 0, errors.New("device reset mid-transfer")
	}
	err := p.Print(context.Background(), make([]byte, 20))
	if err == nil {
		t.Fatal("expected failure after partial write")
	}
	if !HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("partial write must be classified unknown: %v", err)
	}
}

func TestUSBWriteZeroByteFailureStaysPlain(t *testing.T) {
	p := &USBPrinter{ID: "u3", Name: "U3", DevicePath: "NUL"}
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		return 0, errors.New("device rejected transfer")
	}
	err := p.Print(context.Background(), []byte("hello"))
	if err == nil {
		t.Fatal("expected write failure")
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("a write that synchronously failed with zero confirmed bytes is provably pre-dispatch and must stay plain: %v", err)
	}
}

func TestUSBWriteExceedingBoundaryIsUnknownAndWedges(t *testing.T) {
	old := usbChunkTimeout
	usbChunkTimeout = 150 * time.Millisecond
	defer func() { usbChunkTimeout = old }()

	p := &USBPrinter{ID: "u4", Name: "U4", DevicePath: "NUL"}
	release := make(chan struct{})
	calls := &atomic.Int32{}
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		calls.Add(1)
		<-release // wedged device: the kernel call never returns
		return uint32(len(chunk)), nil
	}
	start := time.Now()
	err := p.Print(context.Background(), []byte("hello"))
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("stalled write must fail")
	}
	if !HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("a write abandoned mid-syscall may already have transmitted bytes and must be unknown: %v", err)
	}
	if !strings.Contains(err.Error(), "operation boundary") || !strings.Contains(err.Error(), "unknown number of transmitted bytes") {
		t.Fatalf("timeout error must say what happened: %v", err)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("caller was not bounded: Print blocked %v", elapsed)
	}
	if !p.wedged.Load() {
		t.Fatal("abandoned in-flight write must latch the printer wedged")
	}
	before := calls.Load()
	// A wedged printer refuses new dispatches WITHOUT touching hardware:
	// no second job may interleave bytes with the abandoned write.
	err = p.Print(context.Background(), []byte("second job"))
	if err == nil {
		t.Fatal("wedged printer must refuse new dispatch")
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("wedged refusal happens before any byte and must be a plain pre-dispatch error: %v", err)
	}
	if calls.Load() != before {
		t.Fatalf("wedged refusal must not reach the device: calls %d -> %d", before, calls.Load())
	}
	close(release)
}

func TestUSBWriteCancelledInFlightIsUnknown(t *testing.T) {
	p := &USBPrinter{ID: "u5", Name: "U5", DevicePath: "NUL"}
	release := make(chan struct{})
	defer close(release)
	p.writeChunk = func(h windows.Handle, chunk []byte) (uint32, error) {
		<-release // blocks: in-flight kernel write
		return uint32(len(chunk)), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		n, err := p.writeChunkBounded(windows.Handle(0), []byte("hello"), ctx.Done())
		if err == nil {
			done <- nil
			return
		}
		if n != 0 {
			t.Errorf("abandoned write must report zero CONFIRMED bytes, got %d", n)
		}
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected an error after cancellation")
		}
		if !HasUnknownOutcomeMarker(err.Error()) {
			t.Fatalf("cancellation of an in-flight kernel write is ambiguous and must be unknown: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("writeChunkBounded did not respect cancellation")
	}
}
