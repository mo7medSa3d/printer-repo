//go:build !windows

package printer

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"
)

// SpoolerPrinter is the non-Windows stub for Windows spooler printers.
// On Linux/macOS it simulates printing by writing to a temp file, so that
// end-to-end tests and CI can exercise the full Agent -> printer path
// without requiring a real Windows Print Spooler. On a real Windows host,
// the windows-tagged implementation (spooler_windows.go) is used instead.
type SpoolerPrinter struct {
	Name        string
	SpoolerName string
}

// NewSpooler creates a SpoolerPrinter for the given spooler name.
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
	// Simulate spooler submission on non-Windows by writing to temp.
	// This makes test printing succeed without needing winspool.drv.
	dir := os.TempDir()
	if exeDir, err := os.Executable(); err == nil {
		dir = filepath.Dir(exeDir)
	}
	fpath := filepath.Join(dir, fmt.Sprintf("spooler_%s_%d.prn", sanitizeFilename(p.SpoolerName), time.Now().UnixNano()))
	if err := os.WriteFile(fpath, data, 0644); err != nil {
		log.Printf("Spooler stub write failed for %s: %v", p.SpoolerName, err)
		return fmt.Errorf("spooler stub write failed: %w", err)
	}
	log.Printf("Spooler stub printed %d bytes for %s to %s", len(data), p.SpoolerName, fpath)
	return nil
}

func (p *SpoolerPrinter) Test(ctx context.Context) error {
	data := []byte("\x1b\x40Spooler Test Print from Odoo Agent\nPrinter: " + p.SpoolerName + "\n\n\x1d\x56\x01")
	return p.Print(ctx, data)
}

func (p *SpoolerPrinter) Status() string {
	// On non-Windows, there is no real spooler; report online so tests pass.
	// A real Windows build will probe via OpenPrinterW.
	return "online"
}

func sanitizeFilename(s string) string {
	out := ""
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			out += string(r)
		} else if r == ' ' {
			out += "_"
		}
	}
	if out == "" {
		out = "printer"
	}
	return out
}
