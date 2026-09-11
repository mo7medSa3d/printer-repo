package printer

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// tinyPDF returns a minimal one-page PDF (hand-built, no fixtures).
func tinyPDF() []byte {
	var b []byte
	b = append(b, []byte("%PDF-1.4\n")...)
	offsets := []int{0}
	emit := func(body string) {
		offsets = append(offsets, len(b))
		b = append(b, []byte(body)...)
	}
	emit("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
	emit("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n")
	emit("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n")
	emit("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n")
	content := "BT /F1 24 Tf 50 150 Td (Hi) Tj ET\n"
	emit(fmt.Sprintf("5 0 obj\n<< /Length %d >>\nstream\n%sendstream\nendobj\n", len(content), content))
	xref := len(b)
	b = append(b, []byte("xref\n0 6\n0000000000 65535 f \n")...)
	for i := 1; i <= 5; i++ {
		b = append(b, []byte(pad10(offsets[i])+" 00000 n \n")...)
	}
	b = append(b, []byte("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n")...)
	b = append(b, []byte(itoa(xref)+"\n%%EOF\n")...)
	return b
}

func pad10(n int) string {
	s := itoa(n)
	for len(s) < 10 {
		s = "0" + s
	}
	return s
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	if neg {
		digits = append([]byte{'-'}, digits...)
	}
	return string(digits)
}

func TestEmbeddedInvalidPrinterIsDeterministic(t *testing.T) {
	err := printPDFViaEmbedded(context.Background(), `bad"name`, tinyPDF())
	if err == nil {
		t.Fatal("expected error")
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("pre-print validation must not be unknown: %v", err)
	}
}

func TestEmbeddedCancelledBeforeSubmissionIsDeterministic(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := printPDFViaEmbedded(ctx, "Any Printer", tinyPDF())
	if err == nil {
		t.Fatal("expected cancellation error")
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("pre-submission cancel must not be unknown: %v", err)
	}
	if !strings.Contains(err.Error(), "cancelled") {
		t.Fatalf("expected cancel wording, got %v", err)
	}
}

func TestEmbeddedTimeoutBeforeSubmissionIsDeterministic(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	time.Sleep(5 * time.Millisecond) // let the deadline lapse
	err := printPDFViaEmbedded(ctx, "Any Printer", tinyPDF())
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("pre-submission timeout must not be unknown: %v", err)
	}
}

func TestEmbeddedMissingPrinterIsDeterministic(t *testing.T) {
	// No such printer exists on any OS: the device open must fail BEFORE
	// any submission, so the outcome stays plain (retry policy applies)
	// and is never stamped unknown.
	err := printPDFViaEmbedded(context.Background(), "No Such Printer ZZZ 404", tinyPDF())
	if err == nil {
		t.Fatal("expected error")
	}
	if HasUnknownOutcomeMarker(err.Error()) {
		t.Fatalf("unopened printer must not be unknown: %v", err)
	}
}

func TestEmbeddedStagedFileMissing(t *testing.T) {
	err := platformPrintPDF(context.Background(), "Any Printer",
		filepath.Join(t.TempDir(), "does-not-exist.pdf"))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestEmbeddedStagedFileEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty.pdf")
	if err := os.WriteFile(path, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := platformPrintPDF(context.Background(), "Any Printer", path); err == nil {
		t.Fatal("expected error")
	}
}
