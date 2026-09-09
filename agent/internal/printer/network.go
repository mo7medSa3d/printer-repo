package printer

import (
	"context"
	"errors"
	"fmt"
	"log"
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

	// Active preflight BEFORE any payload byte is transmitted. ESC/POS
	// devices have a status back-channel and are probed; a device that does
	// not answer the status inquiry is reported as status-unsupported, which
	// is NEVER treated as proof of health (see PreFlightHealthCheck).
	// TOCTOU notice: preflight cannot eliminate mid-stream paper-out or
	// disconnects; those are classified via UNKNOWN_PARTIAL_DELIVERY below.
	if strings.EqualFold(strings.TrimSpace(p.Protocol), "escpos") {
		probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if err := PreFlightHealthCheck(probeCtx, p.Address); err != nil {
			if errors.Is(err, ErrPrinterStatusUnsupported) {
				log.Printf("printer %s: ESC/POS status channel unavailable (%v); proceeding without health proof", p.Address, err)
			} else {
				return fmt.Errorf("pre-flight health check failed: %w", err)
			}
		}
	}

	d := net.Dialer{Timeout: dialTimeout}
	conn, err := d.DialContext(ctx, "tcp", p.Address)
	if err != nil {
		// Zero bytes sent: provably pre-dispatch failure, safely retryable.
		return fmt.Errorf("%w: dial %s: %w", ErrPrinterOffline, p.Address, err)
	}
	defer conn.Close()

	written := 0
	for written < len(data) {
		select {
		case <-ctx.Done():
			if written > 0 {
				return MarkUnknown("print cancelled after %d/%d bytes: %v", written, len(data), ctx.Err())
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
				return MarkUnknown("write %d/%d to %s: %v", written, len(data), p.Address, err)
			}
			return fmt.Errorf("write %d/%d to %s: %w", written, len(data), p.Address, err)
		}
		if n == 0 {
			if written > 0 {
				return MarkUnknown("short write 0 bytes after %d/%d to %s", written, len(data), p.Address)
			}
			return fmt.Errorf("short write 0 bytes to %s", p.Address)
		}
	}
	return nil
}

// SupportsKind exposes the render paths this byte-stream backend can produce.
// The per-protocol device compatibility decision (which payload protocol may
// touch which device protocol) is enforced by PayloadCompatibleForDevice in
// the job pipeline; this coarse gate only reflects transport capability.
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
		if !strings.EqualFold(strings.TrimSpace(p.Protocol), "escpos") {
			return CapabilityMismatchf("image payloads are raster-converted for ESC/POS devices only (device protocol %q)", p.Protocol)
		}
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
	if !strings.EqualFold(strings.TrimSpace(p.Protocol), "escpos") {
		return CapabilityMismatchf("local test pages are only supported for ESC/POS TCP devices (device protocol %q); send a protocol-matched test page from the Gateway console", p.Protocol)
	}
	return p.Print(ctx, []byte("\x1b\x40Hello from Odoo Agent!\n\n\x1d\x56\x01"))
}

// Status differentiates transport reachability from device health:
//   - escpos devices are actively probed (DLE EOT). A device that answers
//     with paper-out/cover-open/offline reports "error"/"offline"; a device
//     that accepts TCP but never answers the status inquiry reports
//     "unknown", NEVER "online" (an unreadable status is not proof of
//     health).
//   - unidirectional transports (raw/zpl/tspl byte sinks) report "online"
//     on TCP reachability because that is the strongest claim the transport
//     physically allows; their safety properties come from pre-dispatch
//     dial failure detection and UNKNOWN_PARTIAL_DELIVERY classification on
//     mid-stream writes, not from status telemetry.
func (p *NetworkPrinter) Status() string {
	conn, err := net.DialTimeout("tcp", p.Address, 2*time.Second)
	if err != nil {
		return "offline"
	}
	defer conn.Close()
	if !strings.EqualFold(strings.TrimSpace(p.Protocol), "escpos") {
		return "online"
	}
	_ = conn.SetDeadline(time.Now().Add(1500 * time.Millisecond))
	if _, err := QueryHealthStatus(conn); err != nil {
		var netErr net.Error
		if errors.Is(err, ErrPrinterStatusUnsupported) || (errors.As(err, &netErr) && netErr.Timeout()) {
			return "unknown"
		}
		if errors.Is(err, ErrPrinterOffline) {
			return "offline"
		}
		return "error"
	}
	return "online"
}
