//go:build windows

package printer

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// The printto handler launched by ShellExecuteExW owns the spool submission.
// When our wait times out, the handler may have already rendered and spooled
// pages, so the outcome is ambiguous and must carry an unknown-outcome
// marker (LAW: no retry after possible transmission).
func TestPlatformPDFTimeoutIsUnknownOutcome(t *testing.T) {
	tmp := t.TempDir()
	pdfPath := tmp + `\law1.pdf`
	if err := os.WriteFile(pdfPath, validPDF(), 0o600); err != nil {
		t.Fatalf("write temp pdf: %v", err)
	}
	// "cmd /C pause" never exits on its own; the short ctx deadline forces
	// the WAIT_TIMEOUT branch in platformPrintPDF.
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	err := platformPrintPDF(ctx, "Microsoft Print to PDF", pdfPath)
	if err == nil {
		t.Fatal("expected timeout error from platformPrintPDF")
	}
	if !OutcomeUnknown(err) {
		t.Fatalf("PDF handler timeout must be classified unknown (got: %v)", err)
	}
	if !strings.HasPrefix(err.Error(), "UNKNOWN_PARTIAL_DELIVERY") {
		t.Fatalf("wire marker missing from message: %v", err)
	}
}
