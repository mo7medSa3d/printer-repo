//go:build windows

package printer

import (
	"context"
	"image"
	"strings"
	"testing"
	"time"

	"github.com/klippa-app/go-pdfium/requests"
)

func TestPDFiumEmbeddedRendererSmoke(t *testing.T) {
	pool, err := getPDFiumPool()
	if err != nil {
		t.Fatalf("embedded PDFium initialization failed: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	instance, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		t.Fatalf("get PDFium worker: %v", err)
	}
	defer instance.Close()

	data := validPDF()
	doc, err := instance.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		t.Fatalf("open minimal PDF: %v", err)
	}
	defer instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document})

	count, err := instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
	if err != nil {
		t.Fatalf("get page count: %v", err)
	}
	if count.PageCount != 1 {
		t.Fatalf("page count = %d, want 1", count.PageCount)
	}

	rendered, err := instance.RenderPageInPixels(&requests.RenderPageInPixels{
		Page:   requests.Page{ByIndex: &requests.PageByIndex{Document: doc.Document, Index: 0}},
		Width:  600,
		Height: 800,
	})
	if err != nil {
		t.Fatalf("render PDF page: %v", err)
	}
	defer rendered.Cleanup()
	if rendered.Result.Image == nil {
		t.Fatal("PDFium returned nil RGBA bitmap")
	}
	if rendered.Result.Image.Bounds().Empty() {
		t.Fatal("PDFium returned an empty bitmap")
	}
}

func TestPDFiumRendersRotatedPage(t *testing.T) {
	data := rotatedPDF()
	pool, err := getPDFiumPool()
	if err != nil {
		t.Fatalf("embedded PDFium initialization failed: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	instance, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		t.Fatalf("get PDFium worker: %v", err)
	}
	defer instance.Close()
	doc, err := instance.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		t.Fatalf("open rotated PDF: %v", err)
	}
	defer instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document})
	rendered, err := instance.RenderPageInPixels(&requests.RenderPageInPixels{
		Page:  requests.Page{ByIndex: &requests.PageByIndex{Document: doc.Document, Index: 0}},
		Width: 600, Height: 800,
	})
	if err != nil {
		t.Fatalf("render rotated page: %v", err)
	}
	defer rendered.Cleanup()
	if rendered.Result.Image == nil || rendered.Result.Image.Bounds().Empty() {
		t.Fatal("rotated page produced no bitmap")
	}
	if rendered.Result.Image.Bounds().Dx() <= rendered.Result.Image.Bounds().Dy() {
		t.Fatalf("rotation was not reflected in rendered dimensions: %v", rendered.Result.Image.Bounds())
	}
}

func TestRGBAConversionCompositesTransparency(t *testing.T) {
	img := &image.RGBA{Pix: []byte{
		255, 0, 0, 128,
		0, 255, 0, 255,
	}, Stride: 8, Rect: image.Rect(0, 0, 2, 1)}
	if err := rgbaToBGRAInPlace(img); err != nil {
		t.Fatalf("rgbaToBGRAInPlace: %v", err)
	}
	// Semi-transparent red becomes a white-composited red, stored B,G,R,X.
	if img.Pix[0] != 127 || img.Pix[1] != 127 || img.Pix[2] != 255 || img.Pix[3] != 0 {
		t.Fatalf("unexpected transparent conversion: %v", img.Pix[:4])
	}
	// Opaque green remains green.
	if img.Pix[4] != 0 || img.Pix[5] != 255 || img.Pix[6] != 0 || img.Pix[7] != 0 {
		t.Fatalf("unexpected opaque conversion: %v", img.Pix[4:8])
	}
}

func TestRenderBoundsNeverExceedConfiguredCap(t *testing.T) {
	w, h, err := renderBounds(4960, 7016)
	if err != nil {
		t.Fatalf("renderBounds: %v", err)
	}
	if int64(w)*int64(h) > maxPDFRenderPixels {
		t.Fatalf("render area %dx%d exceeds cap %d", w, h, maxPDFRenderPixels)
	}
	if _, _, err := renderBounds(0, 1); err == nil {
		t.Fatal("invalid printable area must fail closed")
	}
}

func TestEmbeddedPDFErrorClassificationMarker(t *testing.T) {
	err := markPDFDispatchUnknown("Office", "failed while rendering page 2", context.DeadlineExceeded)
	if !OutcomeUnknown(err) {
		t.Fatalf("expected UNKNOWN_PARTIAL_DELIVERY marker, got %v", err)
	}
	if !strings.HasPrefix(err.Error(), "UNKNOWN_PARTIAL_DELIVERY") {
		t.Fatalf("missing unknown-outcome wire marker: %v", err)
	}
}
