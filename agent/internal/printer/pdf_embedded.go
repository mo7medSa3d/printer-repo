package printer

import (
	"context"
	"fmt"
	"os"

	"github.com/odoo-print-agent/agent/internal/pdfium"
)

// Embedded PDF printing orchestration (platform independent; the GDI device
// calls behind printerDC/gdi* resolve per OS in pdf_gdi_windows.go vs
// pdf_gdi_other.go).
//
// Error contract (mirrors the repository's unknown-outcome law):
//   - everything before GDI StartDoc succeeds is a deterministic pre-print
//     failure (invalid PDF, bad printer, corrupt page, pre-submission
//     cancellation): safe to report plainly, retry policy applies;
//   - once StartDoc succeeds, bytes may be spooling: every later failure,
//     including cancellation and timeout, is MarkUnknown — never "not
//     printed".

// embeddedPagePlan is one page's validated render parameters, computed for
// every page BEFORE the spool document opens so a corrupt page fails
// deterministically instead of mid-spool.
type embeddedPagePlan struct {
	dpi      int
	widthPt  float64
	heightPt float64
}

// readBoundedPDFFile reads the staged PDF temp file with a hard cap so a
// swapped-out file can never smuggle an oversized document into the
// renderer. The file was just written from already-validated bytes.
func readBoundedPDFFile(pdfPath string) ([]byte, error) {
	f, err := os.Open(pdfPath)
	if err != nil {
		return nil, fmt.Errorf("open staged PDF: %w", err)
	}
	defer f.Close()
	buf := make([]byte, 0, 512*1024)
	chunk := make([]byte, 256*1024)
	for {
		n, rerr := f.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
			if len(buf) > pdfium.MaxDocumentBytes {
				return nil, fmt.Errorf("staged PDF exceeds %d byte limit", pdfium.MaxDocumentBytes)
			}
		}
		if rerr != nil {
			break
		}
	}
	if len(buf) == 0 {
		return nil, fmt.Errorf("staged PDF is empty")
	}
	return buf, nil
}

func printPDFViaEmbedded(ctx context.Context, printerName string, data []byte) error {
	if err := ValidatePDFPrinterName(printerName); err != nil {
		return fmt.Errorf("refusing embedded PDF print: %w", err)
	}
	doc, err := pdfium.Open(data)
	if err != nil {
		return err
	}
	defer doc.Close()

	// Cancellation before any device is touched is still pre-submission:
	// nothing could have spooled, so report plainly.
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("embedded PDF print on %q cancelled before submission: %w", printerName, err)
	}

	// Preflight every page (size parse + DPI budget) BEFORE opening the
	// spool document, so a corrupt page fails deterministically instead of
	// mid-spool.
	//
	// Printer metrics need a DC; open it now and reuse it for the document.
	hdc, err := printerDC(printerName)
	if err != nil {
		return err
	}
	defer deletePrinterDC(hdc)
	dpiX, _, areaW, areaH := printerMetrics(hdc)
	plans := make([]embeddedPagePlan, 0, doc.PageCount())
	for page := 0; page < doc.PageCount(); page++ {
		wpt, hpt, err := doc.PageSizePoints(page)
		if err != nil {
			return fmt.Errorf("embedded PDF preflight: %w", err)
		}
		dpi, err := selectRenderDPI(wpt, hpt, dpiX, pdfium.MaxRenderPixels)
		if err != nil {
			return fmt.Errorf("embedded PDF preflight: %w", err)
		}
		plans = append(plans, embeddedPagePlan{dpi: dpi, widthPt: wpt, heightPt: hpt})
	}

	if err := gdiStartDoc(hdc, "Odoo Print Gateway PDF"); err != nil {
		return err
	}
	submitted := false
	defer func() {
		if !submitted {
			abortPrinterDoc(hdc)
		}
	}()

	for page, plan := range plans {
		if err := ctx.Err(); err != nil {
			return MarkUnknown("embedded PDF print on %q cancelled after submission started (outcome unknown): %v", printerName, err)
		}
		pix, w, h, err := doc.RenderPageBGRA(page, plan.dpi)
		if err != nil {
			return MarkUnknown("embedded PDF render of page %d on %q failed after submission started (outcome unknown): %v", page+1, printerName, err)
		}
		if err := gdiStartPage(hdc); err != nil {
			return MarkUnknown("embedded PDF print on %q could not start page %d (outcome unknown): %v", printerName, page+1, err)
		}
		pageErr := gdiBlitPage(hdc, pix, w, h, areaW, areaH)
		// Release the page buffer before checking the blit result: peak
		// memory stays at exactly one page regardless of outcome.
		pix = nil
		if pageErr != nil {
			_ = gdiEndPage(hdc)
			return MarkUnknown("embedded PDF print on %q failed painting page %d (outcome unknown): %v", printerName, page+1, pageErr)
		}
		if err := gdiEndPage(hdc); err != nil {
			return MarkUnknown("embedded PDF print on %q could not finish page %d (outcome unknown): %v", printerName, page+1, err)
		}
	}
	if err := gdiEndDoc(hdc); err != nil {
		return MarkUnknown("embedded PDF print on %q did not complete spooling (outcome unknown): %v", printerName, err)
	}
	submitted = true
	return nil
}
