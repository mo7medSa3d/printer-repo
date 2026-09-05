package printer

import (
	"context"
	"testing"
	"time"
)

func TestDocumentContextUsesKindSpecificTimeout(t *testing.T) {
	parent, parentCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer parentCancel()

	pdfCtx, pdfCancel := documentContext(parent, KindPDF)
	defer pdfCancel()
	pdfDeadline, ok := pdfCtx.Deadline()
	if !ok {
		t.Fatal("PDF context must have a deadline")
	}
	pdfRemaining := time.Until(pdfDeadline)
	if pdfRemaining < 110*time.Second || pdfRemaining > 121*time.Second {
		t.Fatalf("PDF timeout should be about 120s, got %s", pdfRemaining)
	}

	rawCtx, rawCancel := documentContext(parent, KindRaw)
	defer rawCancel()
	rawDeadline, ok := rawCtx.Deadline()
	if !ok {
		t.Fatal("RAW context must have a deadline")
	}
	rawRemaining := time.Until(rawDeadline)
	if rawRemaining < 15*time.Second || rawRemaining > 21*time.Second {
		t.Fatalf("RAW timeout should be about 20s, got %s", rawRemaining)
	}
}
