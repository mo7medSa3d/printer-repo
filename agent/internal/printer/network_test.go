package printer

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestNetworkPrinterPrintSuccessAndOffline(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
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
	case <-time.After(2 * time.Second):
		t.Fatalf("timeout waiting for data")
	}

	// Status should be online while listener up
	if s := p.Status(); s != "online" {
		t.Fatalf("expected online, got %s", s)
	}

	ln.Close()
	time.Sleep(100 * time.Millisecond)
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
	// assuming nothing on 1.2.3.4:1 with short timeout
	p := &NetworkPrinter{Address: "192.0.2.1:1"} // TEST-NET-1, should not route
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	err := p.Print(ctx, []byte("hi"))
	if err == nil {
		t.Fatalf("expected dial error")
	}
}
