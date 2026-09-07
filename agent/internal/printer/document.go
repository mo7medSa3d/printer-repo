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
	Kind  string
	Data  []byte
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
	if NormalizeKind(kind) != KindPDF {
		return context.WithTimeout(parent, defaultDocumentPrintTimeout)
	}
	base := context.WithoutCancel(parent)
	ctx, cancel := context.WithTimeout(base, defaultPDFDocumentTimeout)
	return ctx, cancel
}

func PrintDocument(ctx context.Context, p Printer, doc Document) error {
	if p == nil {
		return fmt.Errorf("no printer backend")
	}
	doc.Kind = NormalizeKind(doc.Kind)
	if !SupportsKind(p, doc.Kind) {
		return CapabilityMismatchf("printer does not support %s payloads", doc.Kind)
	}
	printCtx, cancel := documentContext(ctx, doc.Kind)
	defer cancel()
	if dp, ok := p.(DocumentPrinter); ok {
		return dp.PrintDocument(printCtx, doc)
	}
	return p.Print(printCtx, doc.Data)
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
