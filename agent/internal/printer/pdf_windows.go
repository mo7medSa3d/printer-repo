//go:build windows

package printer

import (
	"context"
	"fmt"
	"log"
	"strings"
)

// Windows PDF printing.
//
// The embedded PDFium renderer (internal/pdfium, pdfium.dll beside the agent
// binary) is the DEFAULT path in every execution context, including the
// Windows Service / Session 0: it renders page-by-page to memory bitmaps
// and paints them through the printer's GDI device context. No GUI, no
// ShellExecute, no file associations, no external application.
//
// Path selection (PrintPDF in pdf.go runs first):
//
//	pdf_print_command configured → explicit admin override (runPDFHelper)
//	otherwise                    → printPDFViaEmbedded (pdf_embedded.go)
//
// There is deliberately no ShellExecute "printto" fallback and no external
// renderer discovery: both depend on a PDF application that production
// Windows machines must not be required to install.

// platformPrintPDF prints pdfPath on printerName via the embedded renderer.
func platformPrintPDF(ctx context.Context, printerName, pdfPath string) error {
	// Sanitize printer name: remove trailing backslashes (they escape the
	// closing quote under CommandLineToArgvW rules) and reject quotes.
	sanitizedPrinter := strings.TrimRight(printerName, "\\")
	if strings.ContainsAny(sanitizedPrinter, "\"") {
		return fmt.Errorf("invalid printer name %q: contains quotes", printerName)
	}

	data, err := readBoundedPDFFile(pdfPath)
	if err != nil {
		return err
	}
	log.Printf("PDF on %q via embedded PDFium renderer (%d bytes)", sanitizedPrinter, len(data))
	return printPDFViaEmbedded(ctx, sanitizedPrinter, data)
}
