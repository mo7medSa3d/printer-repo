package printer

import (
	"context"
	"fmt"
	"net"
	"time"
)

const maxPrintBytes = 5 * 1024 * 1024

const (
	// dialTimeout bounds the TCP handshake only — never the document.
	dialTimeout = 10 * time.Second
	// writeStallTimeout bounds a SINGLE socket write. A 5MB document on a
	// slow thermal printer legitimately takes minutes to transfer, so the
	// whole transfer must NOT be capped by one overall timer (that cut
	// long writes mid-payload and left partial prints). Instead: each write
	// may block at most this long before we conclude the device is stuck.
	writeStallTimeout = 60 * time.Second
)

type NetworkPrinter struct {
	Address string // e.g. "192.168.1.50:9100"
}

// Print transmits data over RAW TCP with context-aware dialing, per-write
// stall detection, and a loop that handles short writes. Success means the
// bytes were handed to the OS socket — NOT that paper physically came out.
// See PRINTERS.md.
func (p *NetworkPrinter) Print(ctx context.Context, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("payload %d bytes exceeds %d limit", len(data), maxPrintBytes)
	}
	d := net.Dialer{Timeout: dialTimeout}
	conn, err := d.DialContext(ctx, "tcp", p.Address)
	if err != nil {
		return fmt.Errorf("dial %s: %w", p.Address, err)
	}
	defer conn.Close()

	written := 0
	for written < len(data) {
		// respect cancellation between chunks
		select {
		case <-ctx.Done():
			return fmt.Errorf("print cancelled after %d/%d bytes: %w", written, len(data), ctx.Err())
		default:
		}
		// Per-write stall bound: a healthy printer (or even a slow thermal)
		// keeps accepting socket data continuously; a single Write blocked
		// this long means the device died mid-stream.
		_ = conn.SetWriteDeadline(time.Now().Add(writeStallTimeout))
		n, err := conn.Write(data[written:])
		written += n
		if err != nil {
			return fmt.Errorf("write %d/%d to %s: %w", written, len(data), p.Address, err)
		}
		if n == 0 {
			return fmt.Errorf("short write 0 bytes to %s", p.Address)
		}
	}
	return nil
}

// SupportsKind: a RAW TCP socket (port 9100) carries an opaque byte stream.
// It has no renderer, so a PDF must never be written to it.
func (p *NetworkPrinter) SupportsKind(kind string) bool {
	switch NormalizeKind(kind) {
	case KindRaw, KindESCPOS:
		return true
	default:
		return false
	}
}

// PrintDocument enforces the byte-stream contract: raw/escpos are written as
// bytes, anything else (pdf) is refused with CAPABILITY_MISMATCH instead of
// being sent as unrenderable data.
func (p *NetworkPrinter) PrintDocument(ctx context.Context, doc Document) error {
	kind := NormalizeKind(doc.Kind)
	if !p.SupportsKind(kind) {
		return CapabilityMismatchf("raw TCP printer %s cannot render %s payloads (no renderer on a 9100 byte stream)", p.Address, kind)
	}
	return p.Print(ctx, doc.Data)
}

func (p *NetworkPrinter) Test(ctx context.Context) error {
	// Simple ESC/POS test print — uses same transport as real jobs
	testData := []byte("\x1b\x40Hello from Odoo Agent!\n\n\x1d\x56\x01")
	return p.Print(ctx, testData)
}

// Status probes TCP reachability only (2s timeout). "online" does NOT mean
// the device printed paper — only that the TCP handshake succeeded.
func (p *NetworkPrinter) Status() string {
	conn, err := net.DialTimeout("tcp", p.Address, 2*time.Second)
	if err != nil {
		return "offline"
	}
	conn.Close()
	return "online"
}
