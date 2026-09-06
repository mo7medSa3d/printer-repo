package printer

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestNetworkPrinterPrintDocumentUsesRealTCPTransport(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	payload := []byte("\x1b\x40hello\n\n")
	received := make(chan []byte, 1)
	serverErr := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverErr <- err
			return
		}
		defer conn.Close()
		data, err := io.ReadAll(conn)
		if err != nil {
			serverErr <- err
			return
		}
		received <- data
	}()

	p := &NetworkPrinter{Address: listener.Addr().String()}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := p.PrintDocument(ctx, Document{Kind: string(KindESCPOS), Data: payload, JobID: "integration"}); err != nil {
		t.Fatalf("PrintDocument: %v", err)
	}

	select {
	case data := <-received:
		if string(data) != string(payload) {
			t.Fatalf("receiver got %q, want %q", data, payload)
		}
	case err := <-serverErr:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for simulated TCP printer")
	}
}

func TestNetworkPrinterRejectsPDFBeforeOpeningSocket(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	accepted := make(chan struct{}, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			conn.Close()
			accepted <- struct{}{}
		}
	}()

	p := &NetworkPrinter{Address: listener.Addr().String()}
	err = p.PrintDocument(context.Background(), Document{Kind: string(KindPDF), Data: []byte("%PDF")})
	if err == nil || !IsCapabilityMismatch(err) {
		t.Fatalf("expected CAPABILITY_MISMATCH, got %v", err)
	}

	select {
	case <-accepted:
		t.Fatal("PDF capability rejection must happen before opening TCP connection")
	case <-time.After(150 * time.Millisecond):
	}
}
