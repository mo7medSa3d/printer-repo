package printer

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// Document kinds. They mirror the payload contract shared with the gateway
// (agent/internal/payload/payload.go and src/lib/payload.ts) — a print job
// carries EXACTLY one of these and the agent must pick a physically correct
// print path for it. A PDF is never silently downgraded to a raw byte stream.
const (
	KindRaw    = "raw"
	KindESCPOS = "escpos"
	KindPDF    = "pdf"
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

// VerifiedKindSupporter is used when support depends on live device
// capabilities rather than a backend's static implementation.
type VerifiedKindSupporter interface {
	SupportsKindVerified(ctx context.Context, kind string) bool
}

func NormalizeKind(kind string) string {
	k := strings.ToLower(strings.TrimSpace(kind))
	if k == "" {
		return KindRaw
	}
	return k
}

// SupportsKind reports whether p can physically print the given document kind.
// Backends with protocol-level capability discovery get precedence over a
// static KindSupporter declaration.
func SupportsKind(p Printer, kind string) bool {
	k := NormalizeKind(kind)
	if verified, ok := p.(VerifiedKindSupporter); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 3*1e9)
		defer cancel()
		return verified.SupportsKindVerified(ctx, k)
	}
	if ks, ok := p.(KindSupporter); ok {
		return ks.SupportsKind(k)
	}
	return k == KindRaw || k == KindESCPOS
}

func PrintDocument(ctx context.Context, p Printer, doc Document) error {
	if p == nil {
		return fmt.Errorf("no printer backend")
	}
	doc.Kind = NormalizeKind(doc.Kind)
	if !SupportsKind(p, doc.Kind) {
		return CapabilityMismatchf("printer does not support %s payloads", doc.Kind)
	}
	if dp, ok := p.(DocumentPrinter); ok {
		return dp.PrintDocument(ctx, doc)
	}
	return p.Print(ctx, doc.Data)
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
