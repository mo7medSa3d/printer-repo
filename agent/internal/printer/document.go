package printer

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Document kinds. They mirror the payload contract shared with the gateway
// (agent/internal/payload/payload.go and src/lib/payload.ts) — a print job
// carries EXACTLY one of these and the agent must pick a physically correct
// print path for it. A PDF is never silently downgraded to a raw byte stream.
const (
	KindRaw    = "raw"
	KindESCPOS = "escpos"
	KindPDF    = "pdf"

	// PDF handlers can take substantially longer on first use (driver startup,
	// application cold start) than RAW/ESC-POS socket writes. Keep that timeout
	// independent from the short byte-stream executor deadline.
	defaultDocumentPrintTimeout = 20 * time.Second
	defaultPDFDocumentTimeout   = 120 * time.Second
)

// Document is one print job body as handed to a printer backend.
type Document struct {
	// Kind is "raw", "escpos" or "pdf" (already validated by payload.Parse).
	Kind string
	// Data is the decoded document body.
	Data []byte
	// JobID is the gateway job id, used for log correlation and temp-file names.
	JobID string
}

// ErrCapabilityMismatch marks "this printer cannot physically render this
// payload type". It is reported to the gateway verbatim so the job fails with
// a CAPABILITY_MISMATCH reason instead of printing garbage.
var ErrCapabilityMismatch = errors.New("CAPABILITY_MISMATCH")

func CapabilityMismatchf(format string, args ...interface{}) error {
	return fmt.Errorf("%w: %s", ErrCapabilityMismatch, fmt.Sprintf(format, args...))
}

func IsCapabilityMismatch(err error) bool {
	return errors.Is(err, ErrCapabilityMismatch)
}

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

// documentContext applies a type-specific execution deadline. PDF handlers
// receive their own 120s budget so the gateway/agent's short 20s byte-stream
// deadline cannot incorrectly fail a healthy cold-starting PDF application.
// The caller's cancellation signal is still observed; only its deadline is
// intentionally decoupled for PDF rendering.
func documentContext(parent context.Context, kind string) (context.Context, context.CancelFunc) {
	if NormalizeKind(kind) != KindPDF {
		return context.WithTimeout(parent, defaultDocumentPrintTimeout)
	}
	base := context.WithoutCancel(parent)
	ctx, cancel := context.WithTimeout(base, defaultPDFDocumentTimeout)
	return ctx, func() {
		cancel()
	}
}

// PrintDocument routes a document to the backend's kind-aware path when it has
// one, and refuses (rather than downgrades) payloads the backend cannot render.
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
	kinds := make([]string, 0, 3)
	for _, k := range []string{KindRaw, KindESCPOS, KindPDF} {
		if SupportsKind(p, k) {
			kinds = append(kinds, k)
		}
	}
	return kinds
}
