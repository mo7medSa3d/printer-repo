//go:build windows

package printer

import (
	"context"
	"fmt"
	"image"
	"log"
	"math"
	"os"
	"sync"
	"unsafe"

	pdfium "github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/responses"
	"github.com/klippa-app/go-pdfium/webassembly"
	"github.com/tetratelabs/wazero"
	"golang.org/x/sys/windows"
)

// Embedded Windows PDF pipeline.
//
// PDFium runs in an embedded WebAssembly module through wazero. go-pdfium's
// WebAssembly implementation embeds the PDFium WASM binary, so the Agent has
// no PDFium DLL, native PDF runtime, desktop PDF application, registry association,
// PATH requirement, or runtime download.
//
// Pages are rendered one at a time and submitted through a printer HDC using
// Windows GDI. The same Windows printer stack remains responsible for printer
// selection and physical spooling; RAW/ESC-POS traffic never enters this path.

const (
	maxPDFPages        = 500
	maxPDFRenderPixels = 16_000_000 // <= 64 MiB for one 32-bit bitmap.

	// GetDeviceCaps indices.
	capHorzRes         = 8
	capVertRes         = 10
	capLogPixelsX      = 88
	capLogPixelsY      = 90
	capPhysicalOffsetX = 112
	capPhysicalOffsetY = 113

	biRGB        = 0
	dibRGBColors = 0
	srccopy      = 0x00CC0020
	halftone     = 4
)

type winBITMAPINFOHEADER struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

type winBITMAPINFO struct {
	Header winBITMAPINFOHEADER
	Colors [1]uint32
}

type winDOCINFOW struct {
	CbSize         int32
	LpszDocName    *uint16
	LpszOutputFile *uint16
	LpszDatatype   *uint16
	FwType         uint32
}

var (
	pdfiumOnce sync.Once
	pdfiumPool pdfium.Pool
	pdfiumErr  error

	// PDFium is limited to one live worker. This both bounds memory and keeps
	// GDI page submission serialized so independent PDF jobs cannot overlap
	// on the same renderer/print pipeline.
	embeddedPDFPrintMu sync.Mutex

	modGDI32              = windows.NewLazySystemDLL("gdi32.dll")
	procCreateDCW         = modGDI32.NewProc("CreateDCW")
	procDeleteDC          = modGDI32.NewProc("DeleteDC")
	procGetDeviceCaps     = modGDI32.NewProc("GetDeviceCaps")
	procStartDocW         = modGDI32.NewProc("StartDocW")
	procEndDoc            = modGDI32.NewProc("EndDoc")
	procStartPage         = modGDI32.NewProc("StartPage")
	procEndPage           = modGDI32.NewProc("EndPage")
	procStretchDIBits     = modGDI32.NewProc("StretchDIBits")
	procSetStretchBltMode = modGDI32.NewProc("SetStretchBltMode")
)

func getPDFiumPool() (pdfium.Pool, error) {
	pdfiumOnce.Do(func() {
		pdfiumPool, pdfiumErr = webassembly.Init(webassembly.Config{
			MinIdle:       0,
			MaxIdle:       1,
			MaxTotal:      1,
			ReuseWorkers:  true,
			RuntimeConfig: wazero.NewRuntimeConfig().WithCloseOnContextDone(true),
			FSConfig:      wazero.NewFSConfig(),
		})
	})
	return pdfiumPool, pdfiumErr
}

func openPrinterDC(printerName string) (uintptr, error) {
	driver, err := windows.UTF16PtrFromString("WINSPOOL")
	if err != nil {
		return 0, fmt.Errorf("encode WINSPOOL driver name: %w", err)
	}
	device, err := windows.UTF16PtrFromString(printerName)
	if err != nil {
		return 0, fmt.Errorf("encode printer name: %w", err)
	}
	hdc, _, callErr := procCreateDCW.Call(
		uintptr(unsafe.Pointer(driver)),
		uintptr(unsafe.Pointer(device)),
		0,
		0,
	)
	if hdc == 0 {
		return 0, fmt.Errorf("CreateDCW(%q) failed: %w", printerName, callErr)
	}
	return hdc, nil
}

func deviceCaps(hdc uintptr, index int) int {
	ret, _, _ := procGetDeviceCaps.Call(hdc, uintptr(index))
	return int(int32(ret))
}

func startGDIPrint(hdc uintptr, jobID, printerName string) error {
	title := "OdooPrintAgent PDF"
	if jobID != "" {
		title += " " + jobID
	}
	titlePtr, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return fmt.Errorf("encode print document name: %w", err)
	}
	info := winDOCINFOW{
		CbSize:      int32(unsafe.Sizeof(winDOCINFOW{})),
		LpszDocName: titlePtr,
	}
	ret, _, callErr := procStartDocW.Call(hdc, uintptr(unsafe.Pointer(&info)))
	if int32(ret) <= 0 {
		return fmt.Errorf("StartDocW(%q) failed: %w", printerName, callErr)
	}
	return nil
}

func endGDIPrint(hdc uintptr) error {
	ret, _, callErr := procEndDoc.Call(hdc)
	if int32(ret) <= 0 {
		return fmt.Errorf("EndDoc failed: %w", callErr)
	}
	return nil
}

func startGDIPage(hdc uintptr) error {
	ret, _, callErr := procStartPage.Call(hdc)
	if int32(ret) <= 0 {
		return fmt.Errorf("StartPage failed: %w", callErr)
	}
	return nil
}

func endGDIPage(hdc uintptr) error {
	ret, _, callErr := procEndPage.Call(hdc)
	if int32(ret) <= 0 {
		return fmt.Errorf("EndPage failed: %w", callErr)
	}
	return nil
}

func renderBounds(printableWidth, printableHeight int) (int, int, error) {
	if printableWidth <= 0 || printableHeight <= 0 {
		return 0, 0, fmt.Errorf("printer reported invalid printable area %dx%d", printableWidth, printableHeight)
	}
	maxW, maxH := printableWidth, printableHeight
	area := int64(maxW) * int64(maxH)
	if area > maxPDFRenderPixels {
		scale := math.Sqrt(float64(maxPDFRenderPixels) / float64(area))
		maxW = max(1, int(float64(maxW)*scale))
		maxH = max(1, int(float64(maxH)*scale))
	}
	return maxW, maxH, nil
}

func rgbaToBGRAInPlace(src *image.RGBA) error {
	if src == nil {
		return fmt.Errorf("PDFium returned a nil bitmap")
	}
	width, height := src.Rect.Dx(), src.Rect.Dy()
	if width <= 0 || height <= 0 {
		return fmt.Errorf("PDFium returned an empty bitmap %dx%d", width, height)
	}
	if src.Stride != width*4 {
		return fmt.Errorf("PDFium returned unsupported bitmap stride %d for width %d", src.Stride, width)
	}
	for i := 0; i < len(src.Pix); i += 4 {
		r, g, b, a := src.Pix[i], src.Pix[i+1], src.Pix[i+2], src.Pix[i+3]
		if a != 255 {
			inv := uint32(255 - a)
			r = uint8((uint32(r)*uint32(a) + 255*inv) / 255)
			g = uint8((uint32(g)*uint32(a) + 255*inv) / 255)
			b = uint8((uint32(b)*uint32(a) + 255*inv) / 255)
		}
		src.Pix[i], src.Pix[i+1], src.Pix[i+2], src.Pix[i+3] = b, g, r, 0
	}
	return nil
}

func drawBitmapToPrinter(hdc uintptr, bitmap []byte, width, height, printableWidth, printableHeight, offsetX, offsetY int) error {
	if width <= 0 || height <= 0 || len(bitmap) != width*height*4 {
		return fmt.Errorf("invalid rendered bitmap %dx%d (%d bytes)", width, height, len(bitmap))
	}
	info := winBITMAPINFO{
		Header: winBITMAPINFOHEADER{
			BiSize:        uint32(unsafe.Sizeof(winBITMAPINFOHEADER{})),
			BiWidth:       int32(width),
			BiHeight:      -int32(height), // top-down DIB
			BiPlanes:      1,
			BiBitCount:    32,
			BiCompression: biRGB,
			BiSizeImage:   uint32(len(bitmap)),
		},
	}

	x := offsetX + (printableWidth-width)/2
	y := offsetY + (printableHeight-height)/2
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}

	procSetStretchBltMode.Call(hdc, halftone)
	ret, _, callErr := procStretchDIBits.Call(
		hdc,
		uintptr(x), uintptr(y), uintptr(width), uintptr(height),
		0, 0, uintptr(width), uintptr(height),
		uintptr(unsafe.Pointer(&bitmap[0])),
		uintptr(unsafe.Pointer(&info)),
		dibRGBColors,
		srccopy,
	)
	if int32(ret) <= 0 {
		return fmt.Errorf("StretchDIBits failed for %dx%d bitmap: %w", width, height, callErr)
	}
	return nil
}

func renderPageWithContext(ctx context.Context, instance pdfium.Pdfium, request *requests.RenderPageInPixels) (*image.RGBA, func(), error) {
	type outcome struct {
		rendered *responses.RenderPageInPixels
		err      error
	}
	done := make(chan outcome, 1)
	go func() {
		rendered, err := instance.RenderPageInPixels(request)
		done <- outcome{rendered: rendered, err: err}
	}()

	select {
	case result := <-done:
		if result.err != nil {
			return nil, nil, result.err
		}
		if result.rendered == nil {
			return nil, nil, fmt.Errorf("PDFium returned no render result")
		}
		return result.rendered.Result.Image, result.rendered.Cleanup, nil
	case <-ctx.Done():
		// Kill is the go-pdfium-supported way to interrupt an in-flight WASM
		// worker. The caller decides whether the physical outcome is already
		// ambiguous based on whether StartDocW has occurred.
		_ = instance.Kill()
		return nil, nil, ctx.Err()
	}
}

// platformPrintPDF reads the generated temporary PDF file and submits it to
// the Windows GDI print pipeline rendered via embedded PDFium.
func platformPrintPDF(ctx context.Context, printerName, pdfPath string) error {
	data, err := os.ReadFile(pdfPath)
	if err != nil {
		return fmt.Errorf("read PDF file %q: %w", pdfPath, err)
	}
	return renderAndPrintPDFWithPDFium(ctx, printerName, data)
}

func renderAndPrintPDFWithPDFium(ctx context.Context, printerName string, data []byte) (retErr error) {
	embeddedPDFPrintMu.Lock()
	defer embeddedPDFPrintMu.Unlock()

	if err := ValidatePDFPrinterName(printerName); err != nil {
		return err
	}
	if err := ValidatePDF(data); err != nil {
		return err
	}
	if err := runPreflightBounded(printerName, preflightTimeout, ctx, func() error {
		return preFlightSpoolerCheck(printerName)
	}); err != nil {
		return fmt.Errorf("pre-flight spooler check failed: %w", err)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	pool, err := getPDFiumPool()
	if err != nil {
		return fmt.Errorf("initialize embedded PDFium renderer: %w", err)
	}
	instance, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		return fmt.Errorf("acquire embedded PDFium worker: %w", err)
	}
	defer func() {
		if err := instance.Close(); err != nil && retErr == nil {
			retErr = fmt.Errorf("close embedded PDFium worker: %w", err)
		}
	}()

	doc, err := instance.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		return fmt.Errorf("open PDF with embedded PDFium: %w", err)
	}
	defer instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document})

	pages, err := instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
	if err != nil {
		return fmt.Errorf("read PDF page count: %w", err)
	}
	if pages.PageCount <= 0 {
		return fmt.Errorf("PDF contains no printable pages")
	}
	if pages.PageCount > maxPDFPages {
		return fmt.Errorf("PDF page count %d exceeds embedded renderer limit %d", pages.PageCount, maxPDFPages)
	}

	hdc, err := openPrinterDC(printerName)
	if err != nil {
		return err
	}
	defer procDeleteDC.Call(hdc)

	printableWidth := deviceCaps(hdc, capHorzRes)
	printableHeight := deviceCaps(hdc, capVertRes)
	offsetX := deviceCaps(hdc, capPhysicalOffsetX)
	offsetY := deviceCaps(hdc, capPhysicalOffsetY)
	dpiX := deviceCaps(hdc, capLogPixelsX)
	dpiY := deviceCaps(hdc, capLogPixelsY)
	if printableWidth <= 0 || printableHeight <= 0 {
		return fmt.Errorf("printer %q returned invalid printable area %dx%d", printerName, printableWidth, printableHeight)
	}
	maxW, maxH, err := renderBounds(printableWidth, printableHeight)
	if err != nil {
		return err
	}
	log.Printf("Embedded PDF print on %q: printable=%dx%d offset=%d,%d dpi=%d,%d render-cap=%dx%d pages=%d",
		printerName, printableWidth, printableHeight, offsetX, offsetY, dpiX, dpiY, maxW, maxH, pages.PageCount)

	// Render the first page before StartDocW. A renderer failure here is a
	// deterministic pre-dispatch error, not an unknown physical outcome.
	first, cleanup, err := renderPageWithContext(ctx, instance, &requests.RenderPageInPixels{
		Page:   requests.Page{ByIndex: &requests.PageByIndex{Document: doc.Document, Index: 0}},
		Width:  maxW,
		Height: maxH,
	})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("render PDF page 1/%d: %w", pages.PageCount, err)
	}
	if cleanup == nil {
		cleanup = func() {}
	}
	if err := rgbaToBGRAInPlace(first); err != nil {
		cleanup()
		return fmt.Errorf("prepare PDF page 1/%d bitmap: %w", pages.PageCount, err)
	}

	if err := startGDIPrint(hdc, "embedded-pdf", printerName); err != nil {
		cleanup()
		return err
	}
	docStarted := true
	docEnded := false
	cleanupFirst := true
	defer func() {
		if cleanupFirst {
			cleanup()
		}
		if docStarted && !docEnded {
			if endErr := endGDIPrint(hdc); endErr != nil && retErr == nil {
				retErr = markPDFDispatchUnknown(printerName, "could not finalize the spool document", endErr)
			}
		}
	}()

	printPage := func(pageNumber int, img *image.RGBA) error {
		if err := startGDIPage(hdc); err != nil {
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("could not start page %d", pageNumber), err)
		}
		if err := drawBitmapToPrinter(hdc, img.Pix, img.Rect.Dx(), img.Rect.Dy(), printableWidth, printableHeight, offsetX, offsetY); err != nil {
			_ = endGDIPage(hdc)
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("could not render page %d to the printer", pageNumber), err)
		}
		if err := endGDIPage(hdc); err != nil {
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("could not finalize page %d", pageNumber), err)
		}
		return nil
	}

	if err := printPage(1, first); err != nil {
		cleanup()
		cleanupFirst = false
		return err
	}
	cleanup()
	cleanupFirst = false

	for pageIndex := 1; pageIndex < pages.PageCount; pageIndex++ {
		select {
		case <-ctx.Done():
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("was cancelled before page %d", pageIndex+1), ctx.Err())
		default:
		}

		img, cleanupPage, err := renderPageWithContext(ctx, instance, &requests.RenderPageInPixels{
			Page:   requests.Page{ByIndex: &requests.PageByIndex{Document: doc.Document, Index: pageIndex}},
			Width:  maxW,
			Height: maxH,
		})
		if err != nil {
			if ctx.Err() != nil {
				_ = instance.Kill()
				return markPDFDispatchUnknown(printerName, fmt.Sprintf("was cancelled while rendering page %d", pageIndex+1), ctx.Err())
			}
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("failed while rendering page %d", pageIndex+1), err)
		}
		if cleanupPage == nil {
			cleanupPage = func() {}
		}
		if err := rgbaToBGRAInPlace(img); err != nil {
			cleanupPage()
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("failed while preparing page %d", pageIndex+1), err)
		}
		if err := printPage(pageIndex+1, img); err != nil {
			cleanupPage()
			return err
		}
		cleanupPage()
	}

	if err := endGDIPrint(hdc); err != nil {
		docEnded = true // EndDocW was already attempted; never issue it twice.
		return markPDFDispatchUnknown(printerName, "could not finalize the print job", err)
	}
	docEnded = true
	return nil
}

func markPDFDispatchUnknown(printerName, operation string, cause error) error {
	return MarkUnknown("embedded PDF print on %q %s after StartDocW; physical outcome is unknown: %v", printerName, operation, cause)
}
