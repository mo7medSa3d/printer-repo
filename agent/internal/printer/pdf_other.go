//go:build !windows

package printer

import "context"

// platformPrintPDF intentionally has no external-renderer fallback. The
// production PDF implementation is Windows-specific because this Agent's PDF
// capability is tied to the Windows printer stack.
func platformPrintPDF(ctx context.Context, printerName, pdfPath string) error {
	_ = ctx
	_ = pdfPath
	return CapabilityMismatchf("embedded PDF printing requires the Windows Agent printer backend (printer %q)", printerName)
}
