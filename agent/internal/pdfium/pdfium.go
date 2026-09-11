// Package pdfium renders PDF documents with an embedded PDFium library.
//
// Minimal direct CGO by design: only the ~12 PDFium C functions this agent
// needs are bound, and the package adds ZERO Go modules to the dependency
// graph (the evaluated alternative, a maintained third-party Go binding,
// drags a plugin/gRPC/wasm module universe into a Windows service).
//
// Threading: the PDFium C API keeps process-global state, so every call
// below is serialized behind a package mutex. Rendering is fast (typically
// hundreds of milliseconds per page) and the agent executor already bounds
// overall job concurrency; correctness beats parallelism here.
//
// Memory: strictly page-by-page. Each RenderPageBGRA allocates exactly one
// transient w*h*4 buffer, handed to the caller as a Go slice; nothing is
// retained after the call. FPDF_LoadMemDocument does NOT copy the input,
// so Document keeps the source bytes alive until Close.
package pdfium

/*
#cgo CFLAGS: -I${SRCDIR}/../../third_party/pdfium/include
#cgo windows LDFLAGS: ${SRCDIR}/../../third_party/pdfium/win-x64/pdfium.dll.lib
#cgo linux LDFLAGS: -L${SRCDIR}/../../third_party/pdfium/linux-x64 -lpdfium -Wl,-rpath,${SRCDIR}/../../third_party/pdfium/linux-x64
#include <stdlib.h>
#include "fpdfview.h"
*/
import "C"

import (
	"fmt"
	"sync"
	"unsafe"
)

const (
	// Version of the vendored runtime (must match third_party/pdfium/README.md).
	Version = "PDFium 155.0.8044.0 (chromium/8044, no-V8)"
	// MaxDocumentBytes caps one PDF submission. Aligned with the agent's
	// maxPrintBytes ceiling so the renderer never accepts what the job
	// pipeline would refuse.
	MaxDocumentBytes = 8 * 1024 * 1024
	// MaxPages bounds pathological documents (page tree bombs).
	MaxPages = 1000
	// MaxRenderPixels bounds one transient page buffer (BGRA = 4 bytes/px,
	// so 16M px ≈ 64 MiB worst case, freed immediately after the page).
	MaxRenderPixels = 16_000_000
	// MinRenderDPI / MaxRenderDPI clamp caller-requested resolution.
	MinRenderDPI = 72
	MaxRenderDPI = 600
	// DefaultRenderDPI is crisp on office lasers without ballooning buffers
	// (Letter at 300 DPI ≈ 8.4 MP ≈ 34 MiB transient).
	DefaultRenderDPI = 300
)

var (
	initOnce sync.Once
	mu       sync.Mutex
)

// initLibrary initializes PDFium once per process. DestroyLibrary is
// deliberately never called: tearing down process-global state while
// worker goroutines may still be shutting down invites use-after-free;
// the OS reclaims everything at process exit.
func initLibrary() {
	initOnce.Do(func() {
		mu.Lock()
		defer mu.Unlock()
		C.FPDF_InitLibrary()
	})
}

func lastError() error {
	switch C.FPDF_GetLastError() {
	case C.FPDF_ERR_PASSWORD:
		return fmt.Errorf("PDF is encrypted or password-protected, which the embedded renderer does not open")
	case C.FPDF_ERR_FORMAT:
		return fmt.Errorf("PDF is malformed or not a PDF document")
	case C.FPDF_ERR_SECURITY:
		return fmt.Errorf("PDF uses an unsupported security scheme")
	case C.FPDF_ERR_PAGE:
		return fmt.Errorf("PDF page could not be loaded (content error)")
	case C.FPDF_ERR_FILE:
		return fmt.Errorf("PDF data could not be read")
	default:
		return fmt.Errorf("PDFium reported an error (code %d)", int(C.FPDF_GetLastError()))
	}
}

// Document is one open PDF. Use is sequential per Document (enforced by the
// package mutex); separate Documents must still not be used concurrently
// from multiple goroutines — the agent renders one page at a time anyway.
type Document struct {
	doc   C.FPDF_DOCUMENT
	data  []byte // referenced: FPDF_LoadMemDocument does not copy input
	pages int
}

// Open parses data as a PDF and returns the document. All failures here are
// deterministic pre-print failures (nothing reached any printer).
func Open(data []byte) (*Document, error) {
	initLibrary()
	if len(data) == 0 {
		return nil, fmt.Errorf("refusing to open empty PDF payload")
	}
	if len(data) > MaxDocumentBytes {
		return nil, fmt.Errorf("PDF payload %d bytes exceeds %d limit", len(data), MaxDocumentBytes)
	}
	mu.Lock()
	defer mu.Unlock()
	doc := C.FPDF_LoadMemDocument(unsafe.Pointer(&data[0]), C.int(len(data)), nil)
	if doc == nil {
		return nil, lastError()
	}
	n := int(C.FPDF_GetPageCount(doc))
	if n <= 0 {
		C.FPDF_CloseDocument(doc)
		return nil, fmt.Errorf("PDF contains no pages")
	}
	if n > MaxPages {
		C.FPDF_CloseDocument(doc)
		return nil, fmt.Errorf("PDF page count %d exceeds %d limit", n, MaxPages)
	}
	return &Document{doc: doc, data: data, pages: n}, nil
}

// PageCount reports the number of pages. Valid until Close.
func (d *Document) PageCount() int {
	if d == nil {
		return 0
	}
	return d.pages
}

// PageSizePoints returns the page MediaBox size in PDF points (1/72 inch),
// honoring nothing else: rotation is applied by the renderer itself.
func (d *Document) PageSizePoints(page int) (float64, float64, error) {
	if d == nil || d.doc == nil {
		return 0, 0, fmt.Errorf("PDF document is closed")
	}
	if page < 0 || page >= d.pages {
		return 0, 0, fmt.Errorf("PDF page %d out of range (0..%d)", page, d.pages-1)
	}
	mu.Lock()
	defer mu.Unlock()
	p := C.FPDF_LoadPage(d.doc, C.int(page))
	if p == nil {
		return 0, 0, lastError()
	}
	defer C.FPDF_ClosePage(p)
	w := float64(C.FPDF_GetPageWidthF(p))
	h := float64(C.FPDF_GetPageHeightF(p))
	if w <= 0 || h <= 0 {
		return 0, 0, fmt.Errorf("PDF page %d has invalid size %.2fx%.2f pt", page, w, h)
	}
	return w, h, nil
}

// RenderPageBGRA renders one page at dpi into a freshly allocated BGRA
// buffer (4 bytes/px, row-major, top-down). The buffer is exclusively owned
// by the caller. Embedded /Rotate is honored by PDFium itself.
func (d *Document) RenderPageBGRA(page, dpi int) (pix []byte, w, h int, err error) {
	if d == nil || d.doc == nil {
		return nil, 0, 0, fmt.Errorf("PDF document is closed")
	}
	if page < 0 || page >= d.pages {
		return nil, 0, 0, fmt.Errorf("PDF page %d out of range (0..%d)", page, d.pages-1)
	}
	if dpi < MinRenderDPI {
		dpi = MinRenderDPI
	}
	if dpi > MaxRenderDPI {
		dpi = MaxRenderDPI
	}
	mu.Lock()
	defer mu.Unlock()
	p := C.FPDF_LoadPage(d.doc, C.int(page))
	if p == nil {
		return nil, 0, 0, lastError()
	}
	defer C.FPDF_ClosePage(p)
	pw := float64(C.FPDF_GetPageWidthF(p))
	ph := float64(C.FPDF_GetPageHeightF(p))
	if pw <= 0 || ph <= 0 {
		return nil, 0, 0, fmt.Errorf("PDF page %d has invalid size %.2fx%.2f pt", page, pw, ph)
	}
	w = int(pw*float64(dpi)/72.0 + 0.5)
	h = int(ph*float64(dpi)/72.0 + 0.5)
	if w <= 0 || h <= 0 {
		return nil, 0, 0, fmt.Errorf("PDF page %d renders to invalid size %dx%d at %d DPI", page, w, h, dpi)
	}
	if px := int64(w) * int64(h); px > MaxRenderPixels {
		return nil, 0, 0, fmt.Errorf("PDF page %d at %d DPI needs %d pixels, exceeding %d budget (lower the DPI)", page, dpi, px, MaxRenderPixels)
	}
	size := w * h * 4
	cbuf := C.malloc(C.size_t(size))
	if cbuf == nil {
		return nil, 0, 0, fmt.Errorf("out of memory rendering PDF page %d (%dx%d)", page, w, h)
	}
	defer C.free(cbuf)
	// White paper, opaque: unpainted regions must not come out transparent
	// (GDI printers have no alpha channel).
	bmp := C.FPDFBitmap_CreateEx(C.int(w), C.int(h), C.int(4), cbuf, C.int(w*4))
	if bmp == nil {
		return nil, 0, 0, fmt.Errorf("PDFium could not create %dx%d bitmap", w, h)
	}
	defer C.FPDFBitmap_Destroy(bmp)
	C.FPDFBitmap_FillRect(bmp, 0, 0, C.int(w), C.int(h), 0xFFFFFFFF)
	C.FPDF_RenderPageBitmap(bmp, p, 0, 0, C.int(w), C.int(h), 0, C.int(C.FPDF_ANNOT))
	return C.GoBytes(cbuf, C.int(size)), w, h, nil
}

// Close releases the document. Idempotent; safe to call twice.
func (d *Document) Close() error {
	if d == nil || d.doc == nil {
		return nil
	}
	mu.Lock()
	defer mu.Unlock()
	C.FPDF_CloseDocument(d.doc)
	d.doc = nil
	d.data = nil
	return nil
}
