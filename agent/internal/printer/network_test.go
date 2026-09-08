package printer

import (
	"context"
	"errors"
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

func TestNetworkPrinterPreFlightCheckScenarios(t *testing.T) {
	tests := []struct {
		name          string
		responder     func(conn net.Conn)
		expectErrIs   error
		expectSuccess bool
	}{
		{
			name: "healthy printer succeeds and receives payload",
			responder: func(conn net.Conn) {
				// Responds to DLE EOT 1, 2, 4 with normal status
				cmd := make([]byte, 3)
				for i := 0; i < 3; i++ {
					if _, err := io.ReadFull(conn, cmd); err != nil {
						return
					}
					_, _ = conn.Write([]byte{0x12}) // Normal status byte
				}
			},
			expectSuccess: true,
		},
		{
			name: "paper out fails closed with ErrPrinterPaperOut and sends 0 bytes",
			responder: func(conn net.Conn) {
				cmd := make([]byte, 3)
				for i := 0; i < 3; i++ {
					if _, err := io.ReadFull(conn, cmd); err != nil {
						return
					}
					switch cmd[2] {
					case 1:
						_, _ = conn.Write([]byte{0x12})
					case 2:
						_, _ = conn.Write([]byte{0x12})
					case 4:
						_, _ = conn.Write([]byte{0x72}) // Paper out (bits 5 & 6 = 1 -> 0x60)
					}
				}
			},
			expectErrIs: ErrPrinterPaperOut,
		},
		{
			name: "cover open fails closed with ErrPrinterCoverOpen and sends 0 bytes",
			responder: func(conn net.Conn) {
				cmd := make([]byte, 3)
				for i := 0; i < 2; i++ {
					if _, err := io.ReadFull(conn, cmd); err != nil {
						return
					}
					switch cmd[2] {
					case 1:
						_, _ = conn.Write([]byte{0x12})
					case 2:
						_, _ = conn.Write([]byte{0x16}) // Cover open (bit 2 = 1 -> 0x04)
					}
				}
			},
			expectErrIs: ErrPrinterCoverOpen,
		},
		{
			name: "offline status fails closed with ErrPrinterOffline and sends 0 bytes",
			responder: func(conn net.Conn) {
				cmd := make([]byte, 3)
				if _, err := io.ReadFull(conn, cmd); err != nil {
					return
				}
				// Bit 3 = 1 -> offline
				_, _ = conn.Write([]byte{0x1a})
			},
			expectErrIs: ErrPrinterOffline,
		},
		{
			name: "malformed/garbage response fails closed with ErrPrinterNotReady and sends 0 bytes",
			responder: func(conn net.Conn) {
				cmd := make([]byte, 3)
				if _, err := io.ReadFull(conn, cmd); err != nil {
					return
				}
				// Echoing back probe or arbitrary garbage byte failing (buf[0] & 0x93) == 0x12 framing check
				_, _ = conn.Write([]byte{0xFF})
			},
			expectErrIs: ErrPrinterNotReady,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatalf("listen failed: %v", err)
			}
			defer ln.Close()

			payloadReceived := make(chan []byte, 1)
			go func() {
				// Handle preflight connection
				conn1, err := ln.Accept()
				if err != nil {
					return
				}
				defer conn1.Close()
				tc.responder(conn1)

				// If print is expected to succeed, accept 2nd connection for payload
				if tc.expectSuccess {
					conn2, err := ln.Accept()
					if err != nil {
						return
					}
					defer conn2.Close()
					buf := make([]byte, 4096)
					n, _ := conn2.Read(buf)
					payloadReceived <- buf[:n]
				}
			}()

			p := &NetworkPrinter{
				Address:  ln.Addr().String(),
				Protocol: "escpos",
			}

			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()

			data := []byte("\x1b\x40Hello Print Payload\n")
			err = p.Print(ctx, data)

			if tc.expectSuccess {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				select {
				case got := <-payloadReceived:
					if string(got) != string(data) {
						t.Fatalf("expected payload %q, got %q", data, got)
					}
				case <-time.After(1 * time.Second):
					t.Fatal("timed out waiting for payload delivery")
				}
			} else {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if !errors.Is(err, tc.expectErrIs) {
					t.Fatalf("expected errors.Is(err, %v) == true, got err: %v", tc.expectErrIs, err)
				}
				// Must also satisfy ErrPrinterNotReady base identity
				if !errors.Is(err, ErrPrinterNotReady) {
					t.Fatalf("expected errors.Is(err, ErrPrinterNotReady) == true, got err: %v", err)
				}
				// Must NEVER be reported as unknown partial delivery
				if strings.Contains(err.Error(), "UNKNOWN_PARTIAL_DELIVERY") {
					t.Fatalf("unexpected UNKNOWN_PARTIAL_DELIVERY on preflight failure: %v", err)
				}
			}
		})
	}
}


