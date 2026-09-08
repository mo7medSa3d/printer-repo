package printer

import (
	"context"
	"fmt"
	"net"
	"strings"
	"time"
)

const maxPrintBytes = 5 * 1024 * 1024

const (
	dialTimeout           = 10 * time.Second
	writeStallTimeout     = 60 * time.Second
	networkWriteChunkSize = 16 * 1024
)

type NetworkPrinter struct {
	Address  string
	Protocol string
}

func (p *NetworkPrinter) Print(ctx context.Context, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("payload %d bytes exceeds %d limit", len(data), maxPrintBytes)
	}

	// Active PreFlightHealthCheck before transmitting raster or raw payload bytes.
	if strings.EqualFold(strings.TrimSpace(p.Protocol), "escpos") {
		probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if err := PreFlightHealthCheck(probeCtx, p.Address); err != nil {
			return fmt.Errorf("%w: pre-flight health check failed: %v", ErrPrinterNotReady, err)
		}
	}

	d := net.Dialer{Timeout: dialTimeout}
	conn, err := d.DialContext(ctx, "tcp", p.Address)
	if err != nil {
		return fmt.Errorf("%w: dial %s: %v", ErrPrinterNotReady, p.Address, err)
	}
	defer conn.Close()

	written := 0
	for written < len(data) {
		select {
		case <-ctx.Done():
			if written > 0 {
				return fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: print cancelled after %d/%d bytes: %w", written, len(data), ctx.Err())
			}
			return fmt.Errorf("print cancelled after %d/%d bytes: %w", written, len(data), ctx.Err())
		default:
		}
		chunk := data[written:]
		if len(chunk) > networkWriteChunkSize {
			chunk = chunk[:networkWriteChunkSize]
		}
		_ = conn.SetWriteDeadline(time.Now().Add(writeStallTimeout))
		n, err := conn.Write(chunk)
		written += n
		if err != nil {
			if written > 0 {
				return fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: write %d/%d to %s: %w", written, len(data), p.Address, err)
			}
			return fmt.Errorf("write %d/%d to %s: %w", written, len(data), p.Address, err)
		}
		if n == 0 {
			if written > 0 {
				return fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: short write 0 bytes after %d/%d to %s", written, len(data), p.Address)
			}
			return fmt.Errorf("short write 0 bytes to %s", p.Address)
		}
	}
	return nil
}

// SupportsKind exposes the render paths this byte-stream backend can actually
// produce. JPEG images are converted to ESC/POS before being written.
func (p *NetworkPrinter) SupportsKind(kind string) bool {
	k := NormalizeKind(kind)
	switch strings.ToLower(strings.TrimSpace(p.Protocol)) {
	case "zpl":
		return k == KindRaw || k == KindZPL || k == KindLabel
	case "tspl":
		return k == KindRaw || k == KindTSPL || k == KindLabel
	default:
		switch k {
		case KindRaw, KindESCPOS, KindImage:
			return true
		default:
			return false
		}
	}
}

func (p *NetworkPrinter) PrintDocument(ctx context.Context, doc Document) error {
	kind := NormalizeKind(doc.Kind)
	switch kind {
	case KindRaw, KindESCPOS, KindZPL, KindTSPL, KindLabel:
		return p.Print(ctx, doc.Data)
	case KindImage:
		data, err := JPEGToESCPOS(doc.Data)
		if err != nil {
			return fmt.Errorf("render image for raw TCP printer: %w", err)
		}
		return p.Print(ctx, data)
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
