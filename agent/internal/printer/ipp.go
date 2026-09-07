package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type IPPPrinter struct { URL string; Name string }

func NewIPPPrinter(rawURL, name string) (*IPPPrinter, error) {
	if rawURL == "" { return nil, fmt.Errorf("IPP printer URL required") }
	u, err := normalizeIPPURL(rawURL)
	if err != nil { return nil, err }
	return &IPPPrinter{URL: u, Name: name}, nil
}

func normalizeIPPURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" { return "", fmt.Errorf("empty IPP URL") }
	if !strings.Contains(raw, "://") {
		if _, _, err := net.SplitHostPort(raw); err == nil { raw = "http://" + raw + "/ipp/print"
		} else if net.ParseIP(strings.Trim(raw, "[]")) != nil { raw = "http://" + raw + ":631/ipp/print"
		} else if strings.Contains(raw, ".") && !strings.Contains(raw, "/") { raw = "http://" + raw + ":631/ipp/print"
		} else if !strings.HasPrefix(strings.ToLower(raw), "http") { raw = "http://" + raw }
	}
	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, "ipp://") { raw = "http://" + raw[6:] } else if strings.HasPrefix(lower, "ipps://") { raw = "https://" + raw[7:] }
	u, err := url.Parse(raw)
	if err != nil { return "", fmt.Errorf("invalid IPP URL %q: %w", raw, err) }
	if u.Scheme != "http" && u.Scheme != "https" { return "", fmt.Errorf("IPP URL scheme must be http/https/ipp/ipps, got %q", u.Scheme) }
	if u.Host == "" { return "", fmt.Errorf("IPP URL host missing") }
	if u.Path == "" || u.Path == "/" { u.Path = "/ipp/print" }
	return u.String(), nil
}

func (p *IPPPrinter) Print(ctx context.Context, data []byte) error {
	if len(data) == 0 { return fmt.Errorf("refusing to print empty payload") }
	if len(data) > maxPrintBytes { return fmt.Errorf("payload %d exceeds %d limit", len(data), maxPrintBytes) }
	return p.printDocument(ctx, data, ippFormatOctetStream)
}

func (p *IPPPrinter) PrintDocument(ctx context.Context, doc Document) error {
	kind := NormalizeKind(doc.Kind)
	format, ok := ippDocumentFormatFor(kind)
	if !ok { return CapabilityMismatchf("IPP printer %s cannot render %s payloads", p.URL, kind) }
	data := doc.Data
	if kind == KindPDF {
		if err := ValidatePDF(data); err != nil { return err }
	} else if kind == KindImage {
		if !isJPEG(data) { return fmt.Errorf("image payload is not JPEG") }
		format = ippFormatJPEG
	}
	if len(data) == 0 { return fmt.Errorf("refusing to print empty payload") }
	if len(data) > maxPrintBytes { return fmt.Errorf("payload %d exceeds %d limit", len(data), maxPrintBytes) }
	return p.printDocument(ctx, data, format)
}

func (p *IPPPrinter) SupportsKind(kind string) bool { _, ok := ippDocumentFormatFor(NormalizeKind(kind)); return ok }

func ippDocumentFormatFor(kind string) (string, bool) {
	switch kind {
	case KindPDF: return ippFormatPDF, true
	case KindRaw, KindESCPOS: return ippFormatOctetStream, true
	case KindImage: return ippFormatJPEG, true
	default: return "", false
	}
}

func isJPEG(data []byte) bool { return len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff }

func (p *IPPPrinter) printDocument(ctx context.Context, data []byte, documentFormat string) error {
	if err := ctx.Err(); err != nil { return err }
	ippReq := buildIPPPrintJobWithFormat(p.URL, data, documentFormat)
	req, err := http.NewRequestWithContext(ctx, "POST", p.URL, bytes.NewReader(ippReq))
	if err != nil { return fmt.Errorf("IPP create request for %s: %w", p.URL, err) }
	req.Header.Set("Content-Type", "application/ipp")
	req.Header.Set("Accept", "application/ipp")
	req.Header.Set("Expect", "")
	client := &http.Client{Timeout: 15 * time.Second}
	if deadline, ok := ctx.Deadline(); ok { if timeout := time.Until(deadline); timeout > 0 && timeout < client.Timeout { client.Timeout = timeout } }
	resp, err := client.Do(req)
	if err != nil { return fmt.Errorf("IPP POST to %s failed: %w", p.URL, err) }
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 { return fmt.Errorf("IPP printer %s returned HTTP %d: %s", p.URL, resp.StatusCode, string(body)) }
	status, msg := parseIPPStatus(body)
	if status != 0x0000 { return fmt.Errorf("IPP printer %s returned IPP status 0x%04x (%s): %s", p.URL, status, ippStatusText(status), msg) }
	log.Printf("IPP printed %d bytes to %s (IPP status 0x%04x)", len(data), p.URL, status)
	return nil
}

func (p *IPPPrinter) Test(ctx context.Context) error { return p.Print(ctx, []byte("IPP Test Print for Odoo Agent - Printer: "+p.Name+"\n\n")) }

func (p *IPPPrinter) Status() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second); defer cancel()
	attrs, err := p.getPrinterAttributes(ctx); if err != nil { return "offline" }
	if state := attrs["printer-state"]; state != "" { switch state { case "3": return "online"; case "4": return "busy"; case "5": return "offline" } }
	if reasons := attrs["printer-state-reasons"]; strings.Contains(reasons, "offline") || strings.Contains(reasons, "shutdown") { return "offline" }
	if reasons := attrs["printer-state-reasons"]; strings.Contains(reasons, "media-needed") || strings.Contains(reasons, "toner-empty") { return "error" }
	return "online"
}

func (p *IPPPrinter) getPrinterAttributes(ctx context.Context) (map[string]string, error) {
	ippReq := buildIPPGetPrinterAttributes(p.URL)
	req, err := http.NewRequestWithContext(ctx, "POST", p.URL, bytes.NewReader(ippReq)); if err != nil { return nil, err }
	req.Header.Set("Content-Type", "application/ipp")
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req); if err != nil { return nil, err }
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 { return nil, fmt.Errorf("HTTP %d", resp.StatusCode) }
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024)); status, _ := parseIPPStatus(body)
	if status != 0x0000 { return nil, fmt.Errorf("IPP status 0x%04x", status) }
	return parseIPPAttributes(body), nil
}

const (
	ippFormatOctetStream = "application/octet-stream"
	ippFormatPDF = "application/pdf"
	ippFormatJPEG = "image/jpeg"
)

func buildIPPPrintJob(printerURI string, document []byte) []byte { return buildIPPPrintJobWithFormat(printerURI, document, ippFormatOctetStream) }

func buildIPPPrintJobWithFormat(printerURI string, document []byte, documentFormat string) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00, 0x00, 0x02})
	buf.Write([]byte{0x00, 0x01})
	buf.Write([]byte{0x01})
	writeIPPAttr(&buf, 0x47, "attributes-charset", "utf-8")
	writeIPPAttr(&buf, 0x48, "attributes-natural-language", "en")
	writeIPPAttr(&buf, 0x45, "printer-uri", printerURI)
	writeIPPAttr(&buf, 0x42, "requesting-user-name", "odoo-agent")
	writeIPPAttr(&buf, 0x49, "document-format", documentFormat)
	buf.WriteByte(0x03)
	buf.Write(document)
	return buf.Bytes()
}

func buildIPPGetPrinterAttributes(printerURI string) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00, 0x00, 0x0b})
	buf.Write([]byte{0x00, 0x01, 0x01})
	writeIPPAttr(&buf, 0x47, "attributes-charset", "utf-8")
	writeIPPAttr(&buf, 0x48, "attributes-natural-language", "en")
	writeIPPAttr(&buf, 0x45, "printer-uri", printerURI)
	writeIPPAttr(&buf, 0x4a, "requested-attributes", "printer-state")
	buf.WriteByte(0x03)
	return buf.Bytes()
}

func writeIPPAttr(buf *bytes.Buffer, tag byte, name, value string) {
	buf.WriteByte(tag); binary.Write(buf, binary.BigEndian, uint16(len(name))); buf.WriteString(name); binary.Write(buf, binary.BigEndian, uint16(len(value))); buf.WriteString(value)
}

func parseIPPStatus(body []byte) (uint16, string) { if len(body) < 4 { return 0xffff, "short response" }; return binary.BigEndian.Uint16(body[2:4]), "" }
func ippStatusText(status uint16) string { if status == 0x0000 { return "successful-ok" }; return "ipp-error" }
func parseIPPAttributes(_ []byte) map[string]string { return map[string]string{} }
