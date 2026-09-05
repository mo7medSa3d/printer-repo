package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

type ippCapabilityCacheEntry struct {
	formats []string
	expires time.Time
}

var ippCapabilityCache sync.Map // map[string]ippCapabilityCacheEntry

// SupportsKindVerified queries the printer's live IPP capabilities and only
// reports a document kind when document-format-supported explicitly contains
// the corresponding MIME type. A missing attribute is treated as unknown,
// never as support.
func (p *IPPPrinter) SupportsKindVerified(ctx context.Context, kind string) bool {
	format, ok := ippDocumentFormatFor(NormalizeKind(kind))
	if !ok {
		return false
	}
	return containsFormat(p.supportedIPPFormats(ctx), format)
}

// SupportedKindsVerified fetches document-format-supported once and maps the
// actual MIME types to the agent's supported document kinds.
func (p *IPPPrinter) SupportedKindsVerified(ctx context.Context) []string {
	formats := p.supportedIPPFormats(ctx)
	kinds := make([]string, 0, 3)
	for _, kind := range []string{KindRaw, KindESCPOS, KindPDF} {
		if format, ok := ippDocumentFormatFor(kind); ok && containsFormat(formats, format) {
			kinds = append(kinds, kind)
		}
	}
	return kinds
}

func (p *IPPPrinter) supportedIPPFormats(ctx context.Context) []string {
	if ctx == nil {
		ctx = context.Background()
	}
	if cached, ok := ippCapabilityCache.Load(p.URL); ok {
		entry := cached.(ippCapabilityCacheEntry)
		if time.Now().Before(entry.expires) {
			return append([]string(nil), entry.formats...)
		}
		ippCapabilityCache.Delete(p.URL)
	}

	formats, err := p.getSupportedIPPFormats(ctx)
	if err != nil {
		return nil
	}
	vals := splitCSVFormats(formats)
	ippCapabilityCache.Store(p.URL, ippCapabilityCacheEntry{formats: vals, expires: time.Now().Add(30 * time.Second)})
	return append([]string(nil), vals...)
}

func (p *IPPPrinter) getSupportedIPPFormats(ctx context.Context) (string, error) {
	request := buildIPPGetPrinterAttributesForFormats(p.URL)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.URL, bytes.NewReader(request))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/ipp")
	req.Header.Set("Accept", "application/ipp")

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("unexpected IPP HTTP status %d", resp.StatusCode)
	}
	status, _ := parseIPPStatus(body)
	if !isSuccessfulIPPStatus(status) {
		return "", fmt.Errorf("unexpected IPP status 0x%04x", status)
	}
	attrs := parseIPPAttributes(body)
	formats, ok := attrs["document-format-supported"]
	if !ok || strings.TrimSpace(formats) == "" {
		return "", fmt.Errorf("printer did not report document-format-supported")
	}
	return formats, nil
}

func buildIPPGetPrinterAttributesForFormats(printerURI string) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00})
	binary.Write(&buf, binary.BigEndian, uint16(0x000B))
	binary.Write(&buf, binary.BigEndian, uint32(2))
	buf.WriteByte(0x01)
	writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
	writeIPPAttribute(&buf, 0x48, "attributes-natural-language", "en")
	writeIPPAttribute(&buf, 0x45, "printer-uri", printerURI)
	writeIPPAttribute(&buf, 0x42, "requesting-user-name", "odoo-agent")
	writeIPPAttribute(&buf, 0x44, "requested-attributes", "document-format-supported")
	buf.WriteByte(0x03)
	return buf.Bytes()
}

func splitCSVFormats(csv string) []string {
	parts := strings.Split(csv, ",")
	out := make([]string, 0, len(parts))
	for _, value := range parts {
		value = strings.TrimSpace(value)
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func containsFormat(formats []string, want string) bool {
	for _, format := range formats {
		if strings.EqualFold(strings.TrimSpace(format), want) {
			return true
		}
	}
	return false
}
