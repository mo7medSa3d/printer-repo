package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"strings"
	"time"
)

// SupportsKindVerified queries the printer's live IPP capabilities and only
// reports a document kind when document-format-supported explicitly contains
// the corresponding MIME type. A missing attribute is treated as unknown,
// never as support.
func (p *IPPPrinter) SupportsKindVerified(ctx context.Context, kind string) bool {
	format, ok := ippDocumentFormatFor(NormalizeKind(kind))
	if !ok {
		return false
	}
	attrs, err := p.getSupportedIPPFormats(ctx)
	if err != nil {
		return false
	}
	return containsCSVValue(attrs, format)
}

func (p *IPPPrinter) getSupportedIPPFormats(ctx context.Context) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
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
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", &ippHTTPStatusError{status: resp.StatusCode}
	}
	body := make([]byte, 64*1024)
	n, err := resp.Body.Read(body)
	if n == 0 && err != nil {
		return "", err
	}
	status, _ := parseIPPStatus(body[:n])
	if !isSuccessfulIPPStatus(status) {
		return "", &ippStatusError{status: status}
	}
	attrs := parseIPPAttributes(body[:n])
	formats, ok := attrs["document-format-supported"]
	if !ok || strings.TrimSpace(formats) == "" {
		return "", &ippCapabilityError{}
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

func containsCSVValue(csv, want string) bool {
	for _, value := range strings.Split(csv, ",") {
		if strings.EqualFold(strings.TrimSpace(value), want) {
			return true
		}
	}
	return false
}

type ippHTTPStatusError struct{ status int }
func (e *ippHTTPStatusError) Error() string { return "unexpected IPP HTTP status" }

type ippStatusError struct{ status uint16 }
func (e *ippStatusError) Error() string { return "unexpected IPP status" }

type ippCapabilityError struct{}
func (e *ippCapabilityError) Error() string { return "printer did not report document-format-supported" }
