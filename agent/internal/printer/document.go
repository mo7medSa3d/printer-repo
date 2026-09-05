package printer

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Document kinds. They mirror the payload contract shared with the gateway.
const (
	KindRaw    = "raw"
	KindESCPOS = "escpos"
	KindPDF    = "pdf"
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

func IsCapabilityMismatch(err error) bool {
	return errors.Is(err, ErrCapabilityMismatch)
}

type DocumentPrinter interface {
	PrintDocument(ctx context.Context, doc Document) error
}

type KindSupporter interface {
	SupportsKind(kind string) bool
}

// VerifiedKindSupporter is for backends whose actual device capabilities must
// be queried before a document kind can be considered supported.
type VerifiedKindSupporter interface {
	SupportsKindVerified(ctx context.Context, kind string) bool
}

// VerifiedKindsProvider is available to callers that explicitly want a live
// capability snapshot. The normal SupportedKinds contract remains static so
// legacy heartbeat tests and non-live backends are unaffected.
type VerifiedKindsProvider interface {
	SupportedKindsVerified(ctx context.Context) []string
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
	if verified, ok := p.(VerifiedKindSupporter); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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

// SupportedKinds returns the backend's statically declared kinds. Use
// SupportedKindsVerified through the explicit provider interface when a live
// IPP capability snapshot is required.
func SupportedKinds(p Printer) []string {
	kinds := make([]string, 0, 3)
	for _, k := range []string{KindRaw, KindESCPOS, KindPDF} {
		if ks, ok := p.(KindSupporter); ok {
			if ks.SupportsKind(k) {
				kinds = append(kinds, k)
			}
			continue
		}
		if k == KindRaw || k == KindESCPOS {
			kinds = append(kinds, k)
		}
	}
	return kinds
}
