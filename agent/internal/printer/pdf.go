package printer

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

// PDF printing.
//
// PDFs are rendered by the embedded PDFium backend on Windows. The renderer
// produces one bounded bitmap at a time and the Windows backend submits each
// page through a Windows printer device context. There is deliberately no
// shell, file association, external PDF application, or runtime download in
// the production path.
//
// A path-based callback remains as a dependency-injection seam for tests and
// platform-specific implementations. Production passes nil and therefore
// selects platformPrintPDF.
const (
	pdfHeaderMarker = "%PDF-"
	pdfEOFMarker    = "%%EOF"

	// The header must appear at the very start of the file; a small window is
	// tolerated only for a UTF-8 BOM / stray whitespace written by exporters.
	pdfHeaderSearchWindow = 64
	// %%EOF is the last token of a well-formed PDF; some writers append a few
	// bytes of padding/newlines after it.
	pdfEOFSearchWindow = 4096

	// Maximum time assigned to the embedded render/print pipeline. The agent's
	// caller budget remains authoritative for non-PDF transports, while PDF
	// keeps its existing dedicated budget so a larger document is not clipped
	// by a nearly-expired outer context.
	defaultPDFPrintTimeout = 120 * time.Second
)

type PDFPrintFunc func(ctx context.Context, printerName, pdfPath string) error

func ValidatePDF(data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty PDF payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("PDF payload %d bytes exceeds %d limit", len(data), maxPrintBytes)
	}
	head := data
	if len(head) > pdfHeaderSearchWindow {
		head = head[:pdfHeaderSearchWindow]
	}
	if !bytes.Contains(head, []byte(pdfHeaderMarker)) {
		return fmt.Errorf("payload is not a PDF document (missing %s header)", pdfHeaderMarker)
	}
	tail := data
	if len(tail) > pdfEOFSearchWindow {
		tail = tail[len(tail)-pdfEOFSearchWindow:]
	}
	if !bytes.Contains(tail, []byte(pdfEOFMarker)) {
		return fmt.Errorf("truncated or malformed PDF document (missing %s trailer)", pdfEOFMarker)
	}
	return nil
}

func ValidatePDFPrinterName(name string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("printer name is empty")
	}
	if len(name) > 220 {
		return fmt.Errorf("printer name is too long (%d bytes)", len(name))
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("printer name contains a control character (0x%02x)", r)
		}
	}
	if strings.ContainsAny(name, "\"") {
		return fmt.Errorf("printer name contains a quote character, which is not a valid Windows printer name")
	}
	return nil
}

func writeSecurePDFTemp(data []byte) (string, func(), error) {
	dir, err := os.MkdirTemp("", "odoo-print-pdf-")
	if err != nil {
		return "", func() {}, fmt.Errorf("create temp dir for PDF: %w", err)
	}
	cleanup := func() {
		if err := os.RemoveAll(dir); err != nil {
			log.Printf("WARNING: failed to remove temporary PDF directory %s: %v", dir, err)
		}
	}

	f, err := os.CreateTemp(dir, "job-*.pdf")
	if err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("create temp PDF file: %w", err)
	}
	path := f.Name()
	if err := f.Chmod(0o600); err != nil && !isWindowsChmodUnsupported(err) {
		_ = f.Close()
		cleanup()
		return "", func() {}, fmt.Errorf("restrict temp PDF permissions: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		cleanup()
		return "", func() {}, fmt.Errorf("write temp PDF: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		cleanup()
		return "", func() {}, fmt.Errorf("flush temp PDF: %w", err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("close temp PDF: %w", err)
	}
	return path, cleanup, nil
}

func isWindowsChmodUnsupported(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "not supported")
}

// PrintPDF gives the embedded PDF submission its own 120-second deadline
// while still propagating caller cancellation. A callback can be supplied for
// deterministic tests; production uses the platform renderer.
func PrintPDF(ctx context.Context, printerName string, doc Document, printFn PDFPrintFunc) error {
	if err := ValidatePDF(doc.Data); err != nil {
		return err
	}
	if err := ValidatePDFPrinterName(printerName); err != nil {
		return fmt.Errorf("refusing to print PDF: %w", err)
	}

	if printFn == nil {
		printFn = platformPrintPDF
	}

	path, cleanup, err := writeSecurePDFTemp(doc.Data)
	if err != nil {
		return err
	}
	defer cleanup()

	printCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), defaultPDFPrintTimeout)
	defer cancel()
	parentDone := make(chan struct{})
	defer close(parentDone)
	go func() {
		select {
		case <-ctx.Done():
			cancel()
		case <-parentDone:
		case <-printCtx.Done():
		}
	}()

	if err := printFn(printCtx, printerName, path); err != nil {
		return fmt.Errorf("PDF print on %q failed: %w", printerName, err)
	}
	log.Printf("PDF job %s (%d bytes) submitted to printer %q via embedded PDFium path", doc.JobID, len(doc.Data), printerName)
	return nil
}
