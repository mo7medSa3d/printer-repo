//go:build windows

package printer

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modGdi32          = windows.NewLazySystemDLL("gdi32.dll")
	procCreateDCW     = modGdi32.NewProc("CreateDCW")
	procDeleteDC      = modGdi32.NewProc("DeleteDC")
	procGetDeviceCaps = modGdi32.NewProc("GetDeviceCaps")
	procStartDocW     = modGdi32.NewProc("StartDocW")
	procEndDoc        = modGdi32.NewProc("EndDoc")
	procAbortDoc      = modGdi32.NewProc("AbortDoc")
	procStartPage     = modGdi32.NewProc("StartPage")
	procEndPage       = modGdi32.NewProc("EndPage")
	procStretchDIBits = modGdi32.NewProc("StretchDIBits")
)

const (
	gdiHorzRes     = 8
	gdiVertRes     = 10
	gdiLogPixelsX  = 88
	gdiLogPixelsY  = 90
	gdiSrccopy     = 0x00CC0020
	gdiDibRGBColor = 0
	gdiBiRGB       = 0
)

type gdiDocInfo struct {
	cbSize       int32
	lpszDocName  *uint16
	lpszOutput   *uint16
	lpszDatatype *uint16
	fwType       uint32
}

type gdiBitmapInfoHeader struct {
	biSize          uint32
	biWidth         int32
	biHeight        int32
	biPlanes        uint16
	biBitCount      uint16
	biCompression   uint32
	biSizeImage     uint32
	biXPelsPerMeter int32
	biYPelsPerMeter int32
	biClrUsed       uint32
	biClrImportant  uint32
}

// HardenDllSearch constrains system-wide DLL resolution to the application
// directory and System32, so neither the bundled pdfium.dll nor any future
// plugin can ever be shadowed by a hostile working directory. Safe no-op to
// call repeatedly; failures are logged by the caller, never fatal.
func HardenDllSearch() error {
	const (
		loadLibrarySearchApplicationDir = 0x00000200
		loadLibrarySearchSystem32       = 0x00000800
	)
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	setDefault := kernel32.NewProc("SetDefaultDllDirectories")
	ret, _, err := setDefault.Call(
		uintptr(loadLibrarySearchApplicationDir | loadLibrarySearchSystem32),
	)
	if ret == 0 {
		return fmt.Errorf("SetDefaultDllDirectories: %w", err)
	}
	return nil
}

// printerDC opens a GDI information/display context for the named spooler
// printer. No window, no dialog, no GUI: fully Session-0 safe.
func printerDC(printerName string) (windows.Handle, error) {
	name, err := windows.UTF16PtrFromString(printerName)
	if err != nil {
		return 0, fmt.Errorf("encode printer name: %w", err)
	}
	ret, _, err := procCreateDCW.Call(
		uintptr(0),
		uintptr(unsafe.Pointer(name)),
		uintptr(0),
		uintptr(0),
	)
	if ret == 0 {
		return 0, fmt.Errorf("CreateDC for printer %q failed: %w", printerName, err)
	}
	return windows.Handle(ret), nil
}

// printerMetrics reads resolution and printable area from a printer DC.
// Failures degrade to sane office defaults (300 DPI, Letter) instead of
// refusing the job: metrics only tune quality, never gate printing.
func printerMetrics(hdc windows.Handle) (dpiX, dpiY, areaW, areaH int) {
	dpi := func(idx int, fallback int) int {
		ret, _, _ := procGetDeviceCaps.Call(uintptr(hdc), uintptr(idx))
		if ret <= 0 {
			return fallback
		}
		return int(ret)
	}
	return dpi(gdiLogPixelsX, 300), dpi(gdiLogPixelsY, 300),
		dpi(gdiHorzRes, 2550), dpi(gdiVertRes, 3300)
}

// deletePrinterDC releases a printer device context. Best effort: a leak
// here would only matter across thousands of prints, and callers defer it.
func deletePrinterDC(hdc windows.Handle) {
	_, _, _ = procDeleteDC.Call(uintptr(hdc))
}

// abortPrinterDoc kills a partially spooled document. Best effort; the
// caller already classified the outcome as unknown.
func abortPrinterDoc(hdc windows.Handle) {
	_, _, _ = procAbortDoc.Call(uintptr(hdc))
}

// gdiStartPage / gdiEndPage / gdiEndDoc bracket one painted page and the
// whole spool document. Any failure after StartDoc is ambiguous by
// definition (bytes may be spooling), so callers wrap these as unknown.
func gdiStartPage(hdc windows.Handle) error {
	ret, _, err := procStartPage.Call(uintptr(hdc))
	if int32(ret) <= 0 {
		return fmt.Errorf("StartPage failed: %w", err)
	}
	return nil
}

func gdiEndPage(hdc windows.Handle) error {
	ret, _, err := procEndPage.Call(uintptr(hdc))
	if int32(ret) <= 0 {
		return fmt.Errorf("EndPage failed: %w", err)
	}
	return nil
}

func gdiEndDoc(hdc windows.Handle) error {
	ret, _, err := procEndDoc.Call(uintptr(hdc))
	if int32(ret) <= 0 {
		return fmt.Errorf("EndDoc failed: %w", err)
	}
	return nil
}

// gdiStartDoc begins a spool document on hdc. Success starts physical
// submission: callers must treat every later failure as UNKNOWN outcome.
func gdiStartDoc(hdc windows.Handle, jobName string) error {
	name, err := windows.UTF16PtrFromString(jobName)
	if err != nil {
		return fmt.Errorf("encode job name: %w", err)
	}
	info := gdiDocInfo{cbSize: int32(unsafe.Sizeof(gdiDocInfo{})), lpszDocName: name}
	ret, _, err := procStartDocW.Call(uintptr(hdc), uintptr(unsafe.Pointer(&info)))
	if int32(ret) <= 0 {
		return fmt.Errorf("StartDoc failed: %w", err)
	}
	return nil
}

// gdiBlitPage paints one top-down BGRA buffer onto the open page, scaled to
// fit the printable area with aspect preserved and centered.
func gdiBlitPage(hdc windows.Handle, pix []byte, imgW, imgH, areaW, areaH int) error {
	dw, dh, dx, dy, err := fitPage(imgW, imgH, areaW, areaH)
	if err != nil {
		return err
	}
	if len(pix) < imgW*imgH*4 {
		return fmt.Errorf("page buffer %d bytes too small for %dx%d BGRA", len(pix), imgW, imgH)
	}
	header := gdiBitmapInfoHeader{
		biSize:        uint32(unsafe.Sizeof(gdiBitmapInfoHeader{})),
		biWidth:       int32(imgW),
		biHeight:      -int32(imgH), // negative = top-down, matches renderer output
		biPlanes:      1,
		biBitCount:    32,
		biCompression: gdiBiRGB,
	}
	ret, _, err := procStretchDIBits.Call(
		uintptr(hdc),
		uintptr(dx), uintptr(dy), uintptr(dw), uintptr(dh),
		uintptr(0), uintptr(0), uintptr(imgW), uintptr(imgH),
		uintptr(unsafe.Pointer(&pix[0])),
		uintptr(unsafe.Pointer(&header)),
		uintptr(gdiDibRGBColor),
		uintptr(gdiSrccopy),
	)
	if int32(ret) <= 0 {
		return fmt.Errorf("StretchDIBits painted no scanlines: %w", err)
	}
	return nil
}
