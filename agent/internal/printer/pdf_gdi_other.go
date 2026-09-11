//go:build !windows

package printer

import "errors"

// Non-Windows stubs: the GDI printer path exists only on Windows. The
// embedded orchestration (pdf_embedded.go) is portable and tested
// everywhere; on this platform it always terminates at printerDC with a
// deterministic pre-print error before any submission. Handles are plain
// uintptr here (x/sys/windows does not compile off Windows); callers only
// ever thread the value through, never inspect it.
func printerDC(printerName string) (uintptr, error) {
	return 0, errors.New("GDI printer device contexts require Windows")
}

func deletePrinterDC(hdc uintptr) {}

func abortPrinterDoc(hdc uintptr) {}

func printerMetrics(hdc uintptr) (dpiX, dpiY, areaW, areaH int) {
	return 300, 300, 2550, 3300
}

func gdiStartDoc(hdc uintptr, jobName string) error {
	return errors.New("GDI spool documents require Windows")
}

func gdiStartPage(hdc uintptr) error {
	return errors.New("GDI spool documents require Windows")
}

func gdiEndPage(hdc uintptr) error {
	return errors.New("GDI spool documents require Windows")
}

func gdiEndDoc(hdc uintptr) error {
	return errors.New("GDI spool documents require Windows")
}

func gdiBlitPage(hdc uintptr, pix []byte, imgW, imgH, areaW, areaH int) error {
	return errors.New("GDI spool documents require Windows")
}
