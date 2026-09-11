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
	KindZPL    = "zpl"
	KindTSPL   = "tspl"
	KindLabel  = "label"

	defaultDocumentPrintTimeout  = 20 * time.Second
	defaultRasterDocumentTimeout = 90 * time.Second
	defaultPDFDocumentTimeout    = 120 * time.Second
)

type Document struct {
	Kind  string
	Data  []byte
	JobID string
}

// sanitizeTestText strips C0 controls (incl. ESC) from user-controlled names
// before they are embedded into a diagnostic ticket: a crafted name must not
// be able to inject command bytes into the byte stream.
func sanitizeTestText(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r >= ' ' && r != 0x7f {
			out = append(out, r)
		}
		if len(out) >= 60 {
			break
		}
	}
	return string(out)
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
	return strings.ToLower(strings.TrimSpace(kind))
}

func SupportsKind(p Printer, kind string) bool {
	k := NormalizeKind(kind)
	if k == "" {
		return false
	}
	if ks, ok := p.(KindSupporter); ok {
		return ks.SupportsKind(k)
	}
	return k == KindRaw || k == KindESCPOS
}

// documentContext bounds one physical print. The CALLER's deadline is the
// authority (agent.processJob scales it with payload size: a multi-hundred-KB
// raster on a 9600-baud printer legitimately needs minutes). The kind
// fallback applies ONLY when the parent carries no deadline at all — it must
// never clamp a larger, deliberate budget down to a constant, because cutting
// a legitimate long write mid-payload produces garbage paper plus an unknown
// outcome. PDF deliberately detaches from cancellation: once a document has
// been handed to a real renderer, killing the wait does NOT recall the pages.
func documentContext(parent context.Context, kind string) (context.Context, context.CancelFunc) {
	norm := NormalizeKind(kind)
	if norm == KindPDF {
		base := context.WithoutCancel(parent)
		ctx, cancel := context.WithTimeout(base, defaultPDFDocumentTimeout)
		return ctx, cancel
	}
	if _, hasDeadline := parent.Deadline(); hasDeadline {
		return parent, func() {}
	}
	if norm == KindImage || norm == KindESCPOS {
		return context.WithTimeout(parent, defaultRasterDocumentTimeout)
	}
	return context.WithTimeout(parent, defaultDocumentPrintTimeout)
}

func PrintDocument(ctx context.Context, p Printer, doc Document) error {
	if p == nil {
		return fmt.Errorf("no printer backend")
	}
	doc.Kind = NormalizeKind(doc.Kind)
	if doc.Kind == "" {
		return fmt.Errorf("document kind is required; refusing to guess a print format")
	}
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
	kinds := make([]string, 0, 7)
	for _, k := range []string{KindRaw, KindESCPOS, KindPDF, KindImage, KindZPL, KindTSPL, KindLabel} {
		if SupportsKind(p, k) {
			kinds = append(kinds, k)
		}
	}
	return kinds
}
