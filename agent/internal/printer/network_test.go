package printer

import (
	"context"
	"io"
	"net"
	"strings"
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

func TestNetworkPrinterPartialDelivery(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:19999")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	// Server accepts, reads 10 bytes, and forcefully closes connection with TCP RST
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		buf := make([]byte, 10)
		_, _ = io.ReadFull(conn, buf)
		// Force immediate TCP RST on Windows and Linux by setting linger to 0
		if tcpConn, ok := conn.(*net.TCPConn); ok {
			_ = tcpConn.SetLinger(0)
		}
		_ = conn.Close()
	}()

	p := &NetworkPrinter{Address: "127.0.0.1:19999"}
	// Large payload (2MB) to ensure write loop has multiple iterations and gets interrupted
	largeData := make([]byte, 2*1024*1024)
	for i := range largeData {
		largeData[i] = 'A'
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err = p.Print(ctx, largeData)
	if err == nil {
		t.Fatal("expected error on severed connection")
	}
	// Check that error contains UNKNOWN_PARTIAL_DELIVERY marker
	if !strings.Contains(err.Error(), "UNKNOWN_PARTIAL_DELIVERY") {
		t.Fatalf("expected UNKNOWN_PARTIAL_DELIVERY error marker, got: %v", err)
	}
}

func TestNetworkPrinterPreFlightCheckFailure(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:19992")
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	defer ln.Close()

	// Mock printer responding to DLE EOT status inquiry with Paper Out
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()

		cmd := make([]byte, 3)
		for i := 0; i < 3; i++ {
			if _, err := io.ReadFull(conn, cmd); err != nil {
				return
			}
			switch cmd[2] {
			case 1:
				_, _ = conn.Write([]byte{0x12}) // Online
			case 2:
				_, _ = conn.Write([]byte{0x12}) // Cover closed
			case 4:
				_, _ = conn.Write([]byte{0x72}) // Paper out (bits 5 & 6 = 1 -> 0x60)
			}
		}
	}()

	p := &NetworkPrinter{
		Address:  ln.Addr().String(),
		Protocol: "escpos",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	data := []byte("\x1b\x40Hello Print")
	err = p.Print(ctx, data)
	if err == nil {
		t.Fatal("expected error due to pre-flight paper out, got nil")
	}

	// Must return ErrPrinterNotReady
	if !strings.Contains(err.Error(), "ERR_PRINTER_NOT_READY") {
		t.Fatalf("expected ERR_PRINTER_NOT_READY in error, got: %v", err)
	}

	// Must NOT report partial delivery
	if strings.Contains(err.Error(), "UNKNOWN_PARTIAL_DELIVERY") {
		t.Fatalf("unexpected UNKNOWN_PARTIAL_DELIVERY on pre-flight abort: %v", err)
	}
}


