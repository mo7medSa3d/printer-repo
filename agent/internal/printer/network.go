package printer

import (
	"context"
	"fmt"
	"net"
	"time"
)

const maxPrintBytes = 5 * 1024 * 1024

const (
	dialTimeout      = 10 * time.Second
	writeStallTimeout = 60 * time.Second
)

type NetworkPrinter struct{ Address string }

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
		select {
		case <-ctx.Done():
			return fmt.Errorf("print cancelled after %d/%d bytes: %w", written, len(data), ctx.Err())
		default:
		}
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

// SupportsKind mirrors the Gateway's canonical runtime payload contract.
// A RAW TCP 9100 endpoint is a byte stream: raw and ESC/POS are safe to send
// directly, while PDFs and raster images require a renderer and are therefore
// not advertised as direct capabilities here.
func (p *NetworkPrinter) SupportsKind(kind string) bool {
	switch NormalizeKind(kind) {
	case KindRaw, KindESCPOS:
		return true
	default:
		return false
	}
}

func (p *NetworkPrinter) PrintDocument(ctx context.Context, doc Document) error {
	kind := NormalizeKind(doc.Kind)
	switch kind {
	case KindRaw, KindESCPOS:
		return p.Print(ctx, doc.Data)
	default:
		return CapabilityMismatchf("raw TCP printer %s cannot render %s payloads", p.Address, kind)
	}
}

func (p *NetworkPrinter) Test(ctx context.Context) error {
	return p.Print(ctx, []byte("\x1b\x40Hello from Odoo Agent!\n\n\x1d\x56\x01"))
}

func (p *NetworkPrinter) Status() string {
	conn, err := net.DialTimeout("tcp", p.Address, 2*time.Second)
	if err != nil {
		return "offline"
	}
	conn.Close()
	return "online"
}
