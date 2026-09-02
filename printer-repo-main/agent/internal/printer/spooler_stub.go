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
	// PDFPrint overrides the PDF submission step. When set, the real PDF
	// pipeline (validation + secure temp file + submission + cleanup) runs
	// exactly as it does on Windows.
	PDFPrint PDFPrintFunc
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

// SupportsKind mirrors the Windows spooler backend so routing behaves
// identically in CI and on a real Windows host.
func (p *SpoolerPrinter) SupportsKind(kind string) bool {
	switch NormalizeKind(kind) {
	case KindRaw, KindESCPOS, KindPDF:
		return true
	default:
		return false
	}
}

// PrintDocument runs the real PDF pipeline when a submission function is
// configured. Without one there is no Windows print subsystem here, so the
// non-Windows build keeps its documented simulation behaviour: the validated
// PDF is written out as a .pdf file (never re-labelled as RAW/ESC-POS bytes)
// and the simulation is logged explicitly.
func (p *SpoolerPrinter) PrintDocument(ctx context.Context, doc Document) error {
	switch NormalizeKind(doc.Kind) {
	case KindPDF:
		if p.PDFPrint != nil {
			return PrintPDF(ctx, p.SpoolerName, doc, p.PDFPrint)
		}
		if err := ValidatePDF(doc.Data); err != nil {
			return err
		}
		if err := ValidatePDFPrinterName(p.SpoolerName); err != nil {
			return fmt.Errorf("refusing to print PDF: %w", err)
		}
		fpath := filepath.Join(os.TempDir(), fmt.Sprintf("spooler_%s_%d.pdf", sanitizeFilename(p.SpoolerName), time.Now().UnixNano()))
		if err := os.WriteFile(fpath, doc.Data, 0600); err != nil {
			return fmt.Errorf("spooler stub PDF write failed: %w", err)
		}
		log.Printf("Spooler stub SIMULATED a PDF print of %d bytes for %s to %s (no Windows print subsystem on this OS)", len(doc.Data), p.SpoolerName, fpath)
		return nil
	case KindRaw, KindESCPOS:
		return p.Print(ctx, doc.Data)
	default:
		return CapabilityMismatchf("spooler printer %q cannot render %s payloads", p.SpoolerName, NormalizeKind(doc.Kind))
	}
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
