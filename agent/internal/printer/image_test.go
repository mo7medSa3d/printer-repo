package printer

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"strings"
	"testing"
)

func tinyJPEG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			img.Set(x, y, color.Black)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("jpeg.Encode: %v", err)
	}
	return buf.Bytes()
}

func TestJPEGToESCPOSProducesRasterCommand(t *testing.T) {
	out, err := JPEGToESCPOS(tinyJPEG(t))
	if err != nil {
		t.Fatalf("JPEGToESCPOS: %v", err)
	}
	if len(out) < 16 {
		t.Fatalf("ESC/POS raster too short: %d", len(out))
	}
	if out[0] != 0x1b || out[1] != 0x40 {
		t.Fatalf("missing ESC @ initialize, got %x", out[:2])
	}
	if !bytes.Contains(out, []byte{0x1d, 0x76, 0x30, 0x00}) {
		t.Fatal("missing GS v 0 raster command")
	}
}

func TestJPEGToPDFIsValidPDF(t *testing.T) {
	pdf, err := JPEGToPDF(tinyJPEG(t))
	if err != nil {
		t.Fatalf("JPEGToPDF: %v", err)
	}
	if err := ValidatePDF(pdf); err != nil {
		t.Fatalf("converted PDF failed validation: %v", err)
	}
}

func TestAdaptDocumentConvertsImageForSpoolerAndThermal(t *testing.T) {
	jpegBytes := tinyJPEG(t)

	spooler := newMockSpoolerPrinter("Front Desk")
	adapted, err := AdaptDocument(spooler, Document{Kind: KindImage, Data: jpegBytes, JobID: "job_img_pdf"})
	if err != nil {
		t.Fatalf("spooler AdaptDocument: %v", err)
	}
	if adapted.Kind != KindPDF {
		t.Fatalf("spooler image must become PDF, got %s", adapted.Kind)
	}
	if err := ValidatePDF(adapted.Data); err != nil {
		t.Fatalf("adapted PDF: %v", err)
	}

	thermal := &NetworkPrinter{Address: "127.0.0.1:9100"}
	adapted, err = AdaptDocument(thermal, Document{Kind: KindImage, Data: jpegBytes, JobID: "job_img_escpos"})
	if err != nil {
		t.Fatalf("thermal AdaptDocument: %v", err)
	}
	if adapted.Kind != KindESCPOS {
		t.Fatalf("thermal image must become ESC/POS, got %s", adapted.Kind)
	}
	if !bytes.Contains(adapted.Data, []byte{0x1d, 0x76, 0x30, 0x00}) {
		t.Fatal("thermal conversion must emit an ESC/POS raster")
	}
}

func TestAdaptDocumentLeavesNativeKindsAlone(t *testing.T) {
	thermal := &NetworkPrinter{Address: "127.0.0.1:9100"}
	raw := []byte("\x1b@hello")
	adapted, err := AdaptDocument(thermal, Document{Kind: KindRaw, Data: raw, JobID: "job_raw"})
	if err != nil {
		t.Fatalf("AdaptDocument raw: %v", err)
	}
	if adapted.Kind != KindRaw || !bytes.Equal(adapted.Data, raw) {
		t.Fatalf("raw payload must pass through unchanged: %+v", adapted)
	}
}

func TestAdaptDocumentRejectsPDFOnThermal(t *testing.T) {
	thermal := &NetworkPrinter{Address: "127.0.0.1:9100"}
	_, err := AdaptDocument(thermal, Document{Kind: KindPDF, Data: validPDF(), JobID: "job_pdf"})
	if !IsCapabilityMismatch(err) {
		t.Fatalf("expected CAPABILITY_MISMATCH, got %v", err)
	}
}

func TestPrintDocumentConvertsImageBeforeSpoolerPDFPath(t *testing.T) {
	rec := &recordingPDFPath{}
	mockSp := newMockSpoolerPrinter("POS Queue")
	mockSp.pdfPrintFn = rec.fn

	if err := PrintDocument(context.Background(), mockSp, Document{
		Kind:  KindImage,
		Data:  tinyJPEG(t),
		JobID: "job_pos_receipt",
	}); err != nil {
		t.Fatalf("image print on spooler: %v", err)
	}
	if rec.calls != 1 {
		t.Fatalf("image must travel through the PDF path, got %d PDF submissions", rec.calls)
	}
	if mockSp.rawPrintCalls != 0 {
		t.Fatalf("JPEG must not be sent as RAW bytes, got %d raw prints", mockSp.rawPrintCalls)
	}
}

func TestJPEGToESCPOSRejectsNonJPEG(t *testing.T) {
	_, err := JPEGToESCPOS([]byte("not a jpeg"))
	if err == nil {
		t.Fatal("expected invalid JPEG error")
	}
	if !strings.Contains(err.Error(), "invalid JPEG") && !strings.Contains(err.Error(), "decode JPEG") {
		t.Fatalf("unexpected error: %v", err)
	}
}
