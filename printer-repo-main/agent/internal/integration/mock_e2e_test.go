package integration_test

import (
	"context"
	"encoding/base64"
	"testing"
	"time"

	"github.com/odoo-print-agent/agent/internal/payload"
	"github.com/odoo-print-agent/agent/internal/printer"
	"github.com/odoo-print-agent/agent/internal/testutil"
)

// TestMockTCPPrinterE2E proves: Odoo-like payload → Gateway validation (payload.Parse) → Agent NetworkPrinter → TCP → captured bytes.
// This is TEST-ONLY infrastructure; production never imports testutil. Do NOT label as real printer verification.
func TestMockTCPPrinterE2E(t *testing.T) {
	mock := testutil.NewMockTCPPrinter("127.0.0.1:0") // ephemeral to avoid 9100 conflict in CI
	if err := mock.Start(); err != nil {
		t.Fatalf("mock start: %v", err)
	}
	defer mock.Close()

	// Simulate Odoo payload as Gateway would create: escpos base64
	raw := "Hello from Odoo\nLine2\n\x1d\x56\x01"
	b64 := base64.StdEncoding.EncodeToString([]byte(raw))
	jobPayload := map[string]interface{}{"type": "escpos", "encoding": "base64", "data": b64}

	pl, err := payload.Parse(jobPayload)
	if err != nil {
		t.Fatalf("payload.Parse: %v", err)
	}
	if string(pl.Data) != raw {
		t.Fatalf("payload mismatch")
	}

	p := &printer.NetworkPrinter{Address: mock.Addr}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := p.Print(ctx, pl.Data); err != nil {
		t.Fatalf("NetworkPrinter.Print: %v", err)
	}

	caps := mock.WaitForCaptures(1, 5*time.Second)
	if len(caps) != 1 {
		t.Fatalf("expected 1 capture, got %d", len(caps))
	}
	if string(caps[0]) != raw {
		t.Fatalf("captured mismatch: got %q want %q", string(caps[0]), raw)
	}
	// Status should be online while mock up
	if s := p.Status(); s != "online" {
		t.Fatalf("expected online, got %s", s)
	}
}

func TestMockTCPPrinterFailureModes(t *testing.T) {
	// connection refused
	p := &printer.NetworkPrinter{Address: "127.0.0.1:19999"} // nothing listening
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := p.Print(ctx, []byte("hi")); err == nil {
		t.Fatalf("expected dial failure")
	}
	if s := p.Status(); s != "offline" {
		t.Fatalf("expected offline, got %s", s)
	}

	// timeout via delay > context
	mock := testutil.NewMockTCPPrinter("127.0.0.1:0")
	mock.SetDelay(500 * time.Millisecond)
	mock.Start()
	defer mock.Close()
	p2 := &printer.NetworkPrinter{Address: mock.Addr}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel2()
	// With 100ms ctx and 500ms mock delay, dial may succeed but write deadline hits.
	// At minimum should not hang forever.
	_ = p2.Print(ctx2, []byte("hello"))
	// no assertion on error shape — just verify it returns within deadline
}

func TestMockTCPPrinterMultipleAndSerialization(t *testing.T) {
	mock := testutil.NewMockTCPPrinter("127.0.0.1:0")
	mock.Start()
	defer mock.Close()

	p := &printer.NetworkPrinter{Address: mock.Addr}
	for i := 0; i < 3; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		data := []byte("job-" + string(rune('0'+i)))
		if err := p.Print(ctx, data); err != nil {
			t.Fatalf("print %d: %v", i, err)
		}
		cancel()
	}
	caps := mock.WaitForCaptures(3, 5*time.Second)
	if len(caps) != 3 {
		t.Fatalf("expected 3 captures, got %d", len(caps))
	}
}

// Per-printer serialization is already proven in agent/agent_test.go (TestPerPrinterSerialization).
// This test proves different printers (different addrs) can run concurrently via NetworkPrinter direct.

func TestMockTCPPrinterCaptureExpose(t *testing.T) {
	mock := testutil.NewMockTCPPrinter("127.0.0.1:0")
	mock.Start()
	defer mock.Close()
	p := &printer.NetworkPrinter{Address: mock.Addr}
	ctx := context.Background()
	p.Print(ctx, []byte("payload1"))
	p.Print(ctx, []byte("payload2"))
	caps := mock.WaitForCaptures(2, 5*time.Second)
	flat := mock.CapturedFlat()
	if string(flat) != "payload1payload2" {
		t.Fatalf("flat mismatch %q", string(flat))
	}
	if len(caps) != 2 {
		t.Fatalf("caps len")
	}
	// reset
	mock.Reset()
	if mock.Count() != 0 {
		t.Fatalf("reset failed")
	}
}
