package printer

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Document kinds mirror the Gateway payload contract.
const (
	KindRaw    = "raw"
	KindESCPOS = "escpos"
	KindPDF    = "pdf"
	KindImage  = "image"

	defaultDocumentPrintTimeout = 20 * time.Second
	defaultPDFDocumentTimeout   = 120 * time.Second
)

type Document struct {
	Kind string
	Data []byte
	JobID string
}

var ErrCapabilityMismatch = errors.New("CAPABILITY_MISMATCH")

func CapabilityMismatchf(format string, args ...interface{}) error {
	return fmt.Errorf("%w: %s", ErrCapabilityMismatch, fmt.Sprintf(format, args...))
}

func IsCapabilityMismatch(err error) bool { return errors.Is(err, ErrCapabilityMismatch) }

type DocumentPrinter interface {
	PrintDocument(ctx context.Context, doc Document) error
}

type KindSupporter interface {
	SupportsKind(kind string) bool
}

func NormalizeKind(kind string) string {
	k := strings.ToLower(strings.TrimSpace(kind))
	if k == "" {
		return KindRaw
	}
	return k
}

func SupportsKind(p Printer, kind string) bool {
	k := NormalizeKind(kind)
	if ks, ok := p.(KindSupporter); ok {
		return ks.SupportsKind(k)
	}
	return k == KindRaw || k == KindESCPOS
}

func documentContext(parent context.Context, kind string) (context.Context, context.CancelFunc) {
	if NormalizeKind(kind) == KindPDF {
		// PDF rendering is independently budgeted: do not inherit a nearly-expired
		// job deadline that would collapse the 120s helper window.
		base := context.WithoutCancel(parent)
		return context.WithTimeout(base, defaultPDFDocumentTimeout)
	}
	if _, hasDeadline := parent.Deadline(); hasDeadline {
		// The caller (agent processJob) already sized the print window to the
		// payload. Do not shorten it back to the 20s default.
		return context.WithCancel(parent)
	}
	return context.WithTimeout(parent, defaultDocumentPrintTimeout)
}

// AdaptDocument converts a Gateway payload into a kind the backend can actually
// print. Image (JPEG) is a logical POS/Kitchen representation, not a native
// spooler/RAW protocol: JPEG→PDF for PDF-capable queues, JPEG→ESC/POS raster
// for byte-stream thermals, and native JPEG for IPP.
func AdaptDocument(p Printer, doc Document) (Document, error) {
	if p == nil {
		return Document{}, fmt.Errorf("no printer backend")
	}
	doc.Kind = NormalizeKind(doc.Kind)
	if SupportsKind(p, doc.Kind) {
		return doc, nil
	}
	if doc.Kind != KindImage {
		return Document{}, CapabilityMismatchf("printer does not support %s payloads", doc.Kind)
	}
	if SupportsKind(p, KindPDF) {
		pdf, err := JPEGToPDF(doc.Data)
		if err != nil {
			return Document{}, fmt.Errorf("convert JPEG to PDF: %w", err)
		}
		return Document{Kind: KindPDF, Data: pdf, JobID: doc.JobID}, nil
	}
	if SupportsKind(p, KindESCPOS) || SupportsKind(p, KindRaw) {
		raster, err := JPEGToESCPOS(doc.Data)
		if err != nil {
			return Document{}, fmt.Errorf("convert JPEG to ESC/POS: %w", err)
		}
		return Document{Kind: KindESCPOS, Data: raster, JobID: doc.JobID}, nil
	}
	return Document{}, CapabilityMismatchf("printer does not support %s payloads", doc.Kind)
}

func PrintDocument(ctx context.Context, p Printer, doc Document) error {
	adapted, err := AdaptDocument(p, doc)
	if err != nil {
		return err
	}
	printCtx, cancel := documentContext(ctx, adapted.Kind)
	defer cancel()
	if dp, ok := p.(DocumentPrinter); ok {
		return dp.PrintDocument(printCtx, adapted)
	}
	return p.Print(printCtx, adapted.Data)
}

func SupportedKinds(p Printer) []string {
	kinds := make([]string, 0, 4)
	for _, k := range []string{KindRaw, KindESCPOS, KindPDF, KindImage} {
		if SupportsKind(p, k) {
			kinds = append(kinds, k)
		}
	}
	return kinds
}
