package printer

import (
	"context"
	"fmt"
	"net"
	"time"
)

const maxPrintBytes = 5 * 1024 * 1024

type NetworkPrinter struct {
	Address string // e.g. "192.168.1.50:9100"
}

// Print transmits data over RAW TCP with context-aware dialing, deadline,
// and a loop that handles short writes. Success means the bytes were handed
// to the OS socket — NOT that paper physically came out. See PRINTERS.md.
func (p *NetworkPrinter) Print(ctx context.Context, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("payload %d bytes exceeds %d limit", len(data), maxPrintBytes)
	}
	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", p.Address)
	if err != nil {
		return fmt.Errorf("dial %s: %w", p.Address, err)
	}
	defer conn.Close()

	// Bound total I/O to context deadline or 15s fallback
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	}

	written := 0
	for written < len(data) {
		// respect cancellation between chunks
		select {
		case <-ctx.Done():
			return fmt.Errorf("print cancelled after %d/%d bytes: %w", written, len(data), ctx.Err())
		default:
		}
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
