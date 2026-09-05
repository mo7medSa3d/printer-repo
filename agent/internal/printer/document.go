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

// ErrCapabilityMismatch marks "this printer cannot physically render this
// payload type". It is reported to the gateway verbatim so the job fails with
// a CAPABILITY_MISMATCH reason instead of printing garbage.
var ErrCapabilityMismatch = errors.New("CAPABILITY_MISMATCH")

// CapabilityMismatchf builds an ErrCapabilityMismatch-wrapped error whose
// message always starts with the CAPABILITY_MISMATCH token.
func CapabilityMismatchf(format string, args ...interface{}) error {
	return fmt.Errorf("%w: %s", ErrCapabilityMismatch, fmt.Sprintf(format, args...))
}

// IsCapabilityMismatch reports whether err is a capability mismatch.
func IsCapabilityMismatch(err error) bool {
	return errors.Is(err, ErrCapabilityMismatch)
}

// DocumentPrinter is implemented by backends that need to know the document
// kind to select the correct physical path (e.g. Windows spooler: RAW
// byte-stream vs. PDF rendered through the printer driver).
type DocumentPrinter interface {
	PrintDocument(ctx context.Context, doc Document) error
}

// KindSupporter is implemented by backends that can declare which document
// kinds they accept. Backends that do not implement it are assumed to be
// byte-stream only (raw/escpos).
type KindSupporter interface {
	SupportsKind(kind string) bool
}

// NormalizeKind lower-cases a document kind; an empty kind means "raw bytes".
func NormalizeKind(kind string) string {
	k := strings.ToLower(strings.TrimSpace(kind))
	if k == "" {
		return KindRaw
	}
	return k
}

// SupportsKind reports whether p can physically print the given document kind.
func SupportsKind(p Printer, kind string) bool {
	k := NormalizeKind(kind)
	if ks, ok := p.(KindSupporter); ok {
		return ks.SupportsKind(k)
	}
	// Unknown/legacy backend: byte streams only. PDF requires an explicit
	// PDF-aware path, never an opaque write.
	return k == KindRaw || k == KindESCPOS
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
	if dp, ok := p.(DocumentPrinter); ok {
		return dp.PrintDocument(ctx, doc)
	}
	return p.Print(ctx, doc.Data)
}

// SupportedKinds lists the document kinds a backend accepts. It is reported to
// the gateway in the heartbeat (capabilities.supported_protocols) so routing
// can reject an incompatible job before it is ever queued.
func SupportedKinds(p Printer) []string {
	kinds := make([]string, 0, 3)
	for _, k := range []string{KindRaw, KindESCPOS, KindPDF} {
		if SupportsKind(p, k) {
			kinds = append(kinds, k)
		}
	}
	return kinds
}
