package pdfium

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestMain makes the vendored renderer discoverable when tests run outside
// the install directory: on Windows the loader searches PATH, so the
// win-x64 vendor dir is prepended (Linux links with an absolute rpath and
// needs nothing).
func TestMain(m *testing.M) {
	if runtime.GOOS == "windows" {
		if abs, err := filepath.Abs("../../third_party/pdfium/win-x64"); err == nil {
			pathKey := "PATH"
			sep := string(os.PathListSeparator)
			os.Setenv(pathKey, abs+sep+os.Getenv(pathKey))
		}
	}
	os.Exit(m.Run())
}

// buildTestPDF assembles a minimal valid PDF in memory: pageCount pages of
// size w×h points, each optionally /Rotate-d, with one Helvetica text line
// and one filled vector rect (exercises text + vector rasterization without
// external fixtures).
func buildTestPDF(t *testing.T, pageCount int, w, h float64, rotate int) []byte {
	t.Helper()
	var b []byte
	b = append(b, []byte("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")...)
	offsets := []int{0}
	// obj 1: catalog
	offsets = append(offsets, len(b))
	b = append(b, []byte("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")...)
	// obj 2: pages
	kidRefs := make([]string, 0, pageCount)
	for i := 0; i < pageCount; i++ {
		kidRefs = append(kidRefs, fmt.Sprintf("%d 0 R", 3+i*2))
	}
	offsets = append(offsets, len(b))
	b = append(b, []byte(fmt.Sprintf("2 0 obj\n<< /Type /Pages /Kids [%s] /Count %d >>\nendobj\n", strings.Join(kidRefs, " "), pageCount))...)
	fontNum := 3 + pageCount*2
	for i := 0; i < pageCount; i++ {
		pageNum := 3 + i*2
		contentNum := 4 + i*2
		rot := ""
		if rotate != 0 {
			rot = fmt.Sprintf(" /Rotate %d", rotate)
		}
		offsets = append(offsets, len(b))
		b = append(b, []byte(fmt.Sprintf("%d 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.0f %.0f]%s /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>\nendobj\n", pageNum, w, h, rot, fontNum, contentNum))...)
		content := "BT /F1 24 Tf 50 150 Td (Hello) Tj ET\n0.5 0.5 0.5 rg\n10 10 80 40 re\nf\n"
		offsets = append(offsets, len(b))
		b = append(b, []byte(fmt.Sprintf("%d 0 obj\n<< /Length %d >>\nstream\n%sendstream\nendobj\n", contentNum, len(content), content))...)
	}
	offsets = append(offsets, len(b))
	b = append(b, []byte(fmt.Sprintf("%d 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n", fontNum))...)
	n := fontNum + 1
	xref := len(b)
	b = append(b, []byte(fmt.Sprintf("xref\n0 %d\n0000000000 65535 f \n", n))...)
	for i := 1; i < n; i++ {
		b = append(b, []byte(fmt.Sprintf("%010d 00000 n \n", offsets[i]))...)
	}
	b = append(b, []byte(fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", n, xref))...)
	return b
}

func nonWhitePixels(pix []byte) int {
	n := 0
	for i := 0; i+3 < len(pix); i += 4 {
		if pix[i] != 255 || pix[i+1] != 255 || pix[i+2] != 255 {
			n++
		}
	}
	return n
}

func TestOpenInvalid(t *testing.T) {
	for name, data := range map[string][]byte{
		"empty":   {},
		"nil":     nil,
		"garbage": []byte("this is definitely not a pdf document at all...."),
		"header":  []byte("%PDF-1.4\nno pages here\n%%EOF\n"),
	} {
		if _, err := Open(data); err == nil {
			t.Fatalf("%s: expected error", name)
		}
	}
}

func TestOpenOversize(t *testing.T) {
	big := make([]byte, MaxDocumentBytes+1)
	copy(big, "%PDF-1.4\n")
	if _, err := Open(big); err == nil {
		t.Fatal("expected oversize error")
	}
}

func TestOnePageRender(t *testing.T) {
	data := buildTestPDF(t, 1, 200, 200, 0)
	doc, err := Open(data)
	if err != nil {
		t.Fatal(err)
	}
	defer doc.Close()
	if doc.PageCount() != 1 {
		t.Fatalf("pages=%d", doc.PageCount())
	}
	w, h, err := doc.PageSizePoints(0)
	if err != nil {
		t.Fatal(err)
	}
	if w != 200 || h != 200 {
		t.Fatalf("size=%.0fx%.0f", w, h)
	}
	pix, pw, ph, err := doc.RenderPageBGRA(0, 150)
	if err != nil {
		t.Fatal(err)
	}
	if pw != 417 || ph != 417 {
		t.Fatalf("rendered %dx%d, want 417x417", pw, ph)
	}
	if len(pix) != pw*ph*4 {
		t.Fatalf("buffer %d", len(pix))
	}
	// Opaque white paper + rasterized text/vector content.
	if pix[3] != 255 {
		t.Fatalf("alpha=%d, want opaque", pix[3])
	}
	if n := nonWhitePixels(pix); n < 500 {
		t.Fatalf("only %d non-white pixels; text/vector did not rasterize", n)
	}
}

func TestMultiPageRender(t *testing.T) {
	data := buildTestPDF(t, 3, 100, 100, 0)
	doc, err := Open(data)
	if err != nil {
		t.Fatal(err)
	}
	defer doc.Close()
	if doc.PageCount() != 3 {
		t.Fatalf("pages=%d", doc.PageCount())
	}
	for p := 0; p < 3; p++ {
		pix, w, h, err := doc.RenderPageBGRA(p, 72)
		if err != nil {
			t.Fatalf("page %d: %v", p, err)
		}
		if w != 100 || h != 100 || len(pix) != 100*100*4 {
			t.Fatalf("page %d: %dx%d len %d", p, w, h, len(pix))
		}
	}
}

func TestRotatedPage(t *testing.T) {
	data := buildTestPDF(t, 1, 200, 100, 90)
	doc, err := Open(data)
	if err != nil {
		t.Fatal(err)
	}
	defer doc.Close()
	pix, w, h, err := doc.RenderPageBGRA(0, 72)
	if err != nil {
		t.Fatal(err)
	}
	// PDFium reports page dimensions with /Rotate applied: the 200x100
	// MediaBox rotated 90° renders as 100x200.
	if w != 100 || h != 200 {
		t.Fatalf("rendered %dx%d, want 100x200 (rotation applied)", w, h)
	}
	if n := nonWhitePixels(pix); n == 0 {
		t.Fatal("rotated page rendered blank")
	}
}

func TestPageOutOfRange(t *testing.T) {
	data := buildTestPDF(t, 1, 100, 100, 0)
	doc, err := Open(data)
	if err != nil {
		t.Fatal(err)
	}
	defer doc.Close()
	if _, _, err := doc.PageSizePoints(7); err == nil {
		t.Fatal("expected range error")
	}
	if _, _, _, err := doc.RenderPageBGRA(-1, 150); err == nil {
		t.Fatal("expected range error")
	}
}

func TestCloseIdempotent(t *testing.T) {
	data := buildTestPDF(t, 1, 100, 100, 0)
	doc, err := Open(data)
	if err != nil {
		t.Fatal(err)
	}
	if err := doc.Close(); err != nil {
		t.Fatal(err)
	}
	if err := doc.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := doc.PageSizePoints(0); err == nil {
		t.Fatal("expected closed error")
	}
	var nilDoc *Document
	if nilDoc.PageCount() != 0 {
		t.Fatal("nil doc pages")
	}
	if err := nilDoc.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestDPIClamped(t *testing.T) {
	data := buildTestPDF(t, 1, 612, 792, 0) // Letter
	doc, err := Open(data)
	if err != nil {
		t.Fatal(err)
	}
	defer doc.Close()
	// Absurd DPI first clamps to MaxRenderDPI; Letter at 600 DPI still
	// exceeds the pixel budget, so the refusal (not an unbounded
	// allocation) is the correct outcome.
	if _, _, _, err := doc.RenderPageBGRA(0, 100000); err == nil {
		t.Fatal("expected budget error for absurd DPI on Letter")
	}
	// A sane DPI renders fine.
	pix, w, h, err := doc.RenderPageBGRA(0, 150)
	if err != nil {
		t.Fatal(err)
	}
	if w != 1275 || h != 1650 || len(pix) != w*h*4 {
		t.Fatalf("rendered %dx%d len %d", w, h, len(pix))
	}
}

func TestRenderBudgetEnforced(t *testing.T) {
	// A3-ish page at max DPI must refuse rather than allocate unbounded RAM.
	data := buildTestPDF(t, 1, 1190, 842, 0)
	doc, err := Open(data)
	if err != nil {
		t.Fatal(err)
	}
	defer doc.Close()
	if _, _, _, err := doc.RenderPageBGRA(0, MaxRenderDPI); err == nil {
		t.Fatal("expected budget error for huge page at max DPI")
	}
}
