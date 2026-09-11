package printer

import (
	"testing"

	"github.com/odoo-print-agent/agent/internal/pdfium"
)

func TestFitPagePreservesAspect(t *testing.T) {
	// Wide image into square area: full width, centered vertically.
	dw, dh, dx, dy, err := fitPage(200, 100, 100, 100)
	if err != nil {
		t.Fatal(err)
	}
	if dw != 100 || dh != 50 || dx != 0 || dy != 25 {
		t.Fatalf("got %dx%d at %d,%d", dw, dh, dx, dy)
	}
	// Tall image into wide area.
	dw, dh, dx, dy, err = fitPage(100, 200, 200, 100)
	if err != nil {
		t.Fatal(err)
	}
	if dw != 50 || dh != 100 || dx != 75 || dy != 0 {
		t.Fatalf("got %dx%d at %d,%d", dw, dh, dx, dy)
	}
	// Exact fit is identity (never cropped, never stretched).
	dw, dh, dx, dy, err = fitPage(300, 300, 300, 300)
	if err != nil {
		t.Fatal(err)
	}
	if dw != 300 || dh != 300 || dx != 0 || dy != 0 {
		t.Fatalf("got %dx%d at %d,%d", dw, dh, dx, dy)
	}
}

func TestFitPageRejectsDegenerate(t *testing.T) {
	for _, dims := range [][4]int{{0, 100, 100, 100}, {100, 0, 100, 100}, {100, 100, 0, 100}, {-5, 100, 100, 100}} {
		if _, _, _, _, err := fitPage(dims[0], dims[1], dims[2], dims[3]); err == nil {
			t.Fatalf("expected error for %v", dims)
		}
	}
}

func TestSelectRenderDPIStepsDown(t *testing.T) {
	// Letter at a 600 DPI printer does not fit the 16MP budget at 600
	// (5100x6600), so selection must step down, never exceed printer DPI.
	dpi, err := selectRenderDPI(612, 792, 600, pdfium.MaxRenderPixels)
	if err != nil {
		t.Fatal(err)
	}
	if dpi >= 600 {
		t.Fatalf("dpi=%d should step below 600 for Letter", dpi)
	}
	if dpi < 72 {
		t.Fatalf("dpi=%d below floor", dpi)
	}
	// Small receipt fits at full printer resolution.
	dpi, err = selectRenderDPI(144, 288, 300, pdfium.MaxRenderPixels)
	if err != nil {
		t.Fatal(err)
	}
	if dpi != 300 {
		t.Fatalf("dpi=%d, want 300", dpi)
	}
}

func TestSelectRenderDPIRejectsDegenerate(t *testing.T) {
	if _, err := selectRenderDPI(0, 100, 300, pdfium.MaxRenderPixels); err == nil {
		t.Fatal("expected error for zero width")
	}
	// A poster-sized page cannot fit any budget: deterministic refusal,
	// never an unbounded allocation.
	if _, err := selectRenderDPI(5000, 7000, 600, 1000); err == nil {
		t.Fatal("expected budget error")
	}
}
