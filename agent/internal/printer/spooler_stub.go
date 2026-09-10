//go:build !windows

package printer

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// SpoolerPrinter is a NON-Windows stand-in. There is no Windows print
// subsystem here, so the truthful answer is a failure that says so. A
// simulated write to a file is ONLY performed when an operator explicitly
// sets ODOO_PRINT_AGENT_ALLOW_SIMULATED_TRANSPORT=1 (development/diagnostic
// mode); by default nothing pretends to have printed.
type SpoolerPrinter struct {
	Name        string
	SpoolerName string
	PDFPrint    PDFPrintFunc
	ProbeFunc   func(spoolerName string) string
	Timeout     time.Duration
}

func simulatedTransportAllowed() bool {
	return os.Getenv("ODOO_PRINT_AGENT_ALLOW_SIMULATED_TRANSPORT") == "1"
}

func NewSpooler(spoolerName, displayName string) *SpoolerPrinter {
	name := spoolerName
	if displayName != "" {
		name = displayName
	}
	return &SpoolerPrinter{Name: name, SpoolerName: spoolerName}
}

func (p *SpoolerPrinter) Print(ctx context.Context, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("payload %d exceeds %d limit", len(data), maxPrintBytes)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	if !simulatedTransportAllowed() {
		return fmt.Errorf("ERR_UNSUPPORTED_TRANSPORT: the Windows spooler backend cannot run on this OS; nothing was printed to %q", p.SpoolerName)
	}
	dir := os.TempDir()
	fpath := filepath.Join(dir, fmt.Sprintf("spooler_%s_%d.prn", sanitizeFilename(p.SpoolerName), time.Now().UnixNano()))
	if err := os.WriteFile(fpath, data, 0600); err != nil {
		return fmt.Errorf("simulated spooler write failed: %w", err)
	}
	return fmt.Errorf("SIMULATED_TRANSPORT: spooler print was written to %s instead of hardware (ODOO_PRINT_AGENT_ALLOW_SIMULATED_TRANSPORT=1)", fpath)
}

func (p *SpoolerPrinter) SupportsKind(kind string) bool {
	switch NormalizeKind(kind) {
	case KindRaw, KindESCPOS, KindPDF:
		return true
	default:
		return false
	}
}

func (p *SpoolerPrinter) PrintDocument(ctx context.Context, doc Document) error {
	switch NormalizeKind(doc.Kind) {
	case KindPDF:
		if !simulatedTransportAllowed() {
			return fmt.Errorf("ERR_UNSUPPORTED_TRANSPORT: the Windows spooler backend cannot run on this OS; nothing was printed to %q", p.SpoolerName)
		}
		if err := ValidatePDF(doc.Data); err != nil {
			return err
		}
		fpath := filepath.Join(os.TempDir(), fmt.Sprintf("spooler_%s_%d.pdf", sanitizeFilename(p.SpoolerName), time.Now().UnixNano()))
		if err := os.WriteFile(fpath, doc.Data, 0600); err != nil {
			return fmt.Errorf("simulated spooler PDF write failed: %w", err)
		}
		return fmt.Errorf("SIMULATED_TRANSPORT: PDF was written to %s instead of hardware (ODOO_PRINT_AGENT_ALLOW_SIMULATED_TRANSPORT=1)", fpath)
	case KindRaw, KindESCPOS:
		return p.Print(ctx, doc.Data)
	default:
		return CapabilityMismatchf("spooler printer %q cannot render %s payloads", p.SpoolerName, NormalizeKind(doc.Kind))
	}
}

func (p *SpoolerPrinter) Test(ctx context.Context) error {
	return p.Print(ctx, []byte("Spooler Test Print"))
}

func sanitizeFilename(s string) string {
	out := ""
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			out += string(r)
		}
	}
	if out == "" {
		return "printer"
	}
	return out
}

// Status runs an injected ProbeFunc under a bounded deadline (a wedged
// spooler RPC must never block the heartbeat) and recovers probe panics.
// With no probe available (this platform has no Windows print subsystem),
// the honest answer is UNREADABLE - not a healthy "online".
func (p *SpoolerPrinter) Status() string {
	if p.ProbeFunc != nil {
		timeout := p.Timeout
		if timeout <= 0 {
			timeout = 1500 * time.Millisecond
		}
		resCh := make(chan string, 1)
		go func() {
			defer func() {
				if r := recover(); r != nil {
					resCh <- "error"
				}
			}()
			resCh <- p.ProbeFunc(p.SpoolerName)
		}()
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case st := <-resCh:
			return st
		case <-timer.C:
			return "spooler_rpc_unresponsive"
		}
	}
	if simulatedTransportAllowed() {
		return "online"
	}
	return "unknown"
}
