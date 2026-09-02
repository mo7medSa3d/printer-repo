package printer

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestNetworkPrinterPrintSuccessAndOffline(t *testing.T) {
	// Static TEST port (not net.Listen(":0")): after we close the listener the
	// freed ephemeral port could otherwise be stolen by another package's
	// net.Listen(":0") running in parallel under `go test ./...`, which would
	// make the "offline" assertion below flaky. See failure_test.go for the
	// same rationale.
	ln, err := net.Listen("tcp", "127.0.0.1:19996")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	addr := ln.Addr().String()

	received := make(chan []byte, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 4096)
		n, _ := conn.Read(buf)
		received <- buf[:n]
	}()

	p := &NetworkPrinter{Address: addr}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data := []byte("hello printer")
	if err := p.Print(ctx, data); err != nil {
		t.Fatalf("Print: %v", err)
	}
	select {
	case got := <-received:
		if string(got) != string(data) {
			t.Fatalf("expected %q got %q", data, got)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("timeout waiting for data")
	}

	// Status should be online while listener up
	if s := p.Status(); s != "online" {
		t.Fatalf("expected online, got %s", s)
	}

	ln.Close()
	// Give the OS a moment to release the socket before asserting offline.
	time.Sleep(200 * time.Millisecond)
	// dial to closed port should be offline
	p2 := &NetworkPrinter{Address: addr}
	if s := p2.Status(); s != "offline" {
		t.Fatalf("expected offline, got %s", s)
	}
}

func TestNetworkPrinterPrintEmptyAndOversized(t *testing.T) {
	p := &NetworkPrinter{Address: "127.0.0.1:9100"}
	if err := p.Print(context.Background(), []byte{}); err == nil {
		t.Fatalf("expected error for empty")
	}
	huge := make([]byte, maxPrintBytes+1)
	if err := p.Print(context.Background(), huge); err == nil {
		t.Fatalf("expected error for oversized")
	}
}

func TestNetworkPrinterDialFailure(t *testing.T) {
	// Static TEST port with nothing listening -> deterministic ECONNREFUSED on
	// any network. A routable TEST-NET address (192.0.2.1) depends on the
	// runner's routing: some CI networks time out (slow but passing) while a
	// misconfigured route would even dial successfully, flipping the test.
	p := &NetworkPrinter{Address: "127.0.0.1:19998"}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := p.Print(ctx, []byte("hi"))
	if err == nil {
		t.Fatalf("expected dial error")
	}
}
