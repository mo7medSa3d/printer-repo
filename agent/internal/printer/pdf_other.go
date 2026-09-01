//go:build !windows

package printer

import (
	"context"
	"fmt"
	"runtime"
)

// platformPrintPDF has no deterministic PDF submission path outside Windows.
//
// It fails loudly instead of falling back to a RAW byte write: printing a PDF
// as an opaque byte stream is exactly the bug this pipeline exists to prevent.
// A non-Windows host can still print PDFs by configuring an explicit helper
// (pdf_print_command in agent.yaml, e.g. lp/lpr or SumatraPDF under Wine).
func platformPrintPDF(ctx context.Context, printerName, pdfPath string) error {
	return fmt.Errorf(
		"PDF printing is not supported on %s without an explicit helper: set pdf_print_command in agent.yaml (printer %q)",
		runtime.GOOS, printerName,
	)
}
