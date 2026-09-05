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

// IPPPrinter implements IPP/IPPS printing via HTTP POST to printer URI.
// Supports ipp://, ipps://, http://, https:// with path /ipp/print etc.
type IPPPrinter struct {
	URL  string // normalized http(s) URL
	Name string
}

func NewIPPPrinter(rawURL, name string) (*IPPPrinter, error) {
	if rawURL == "" {
		return nil, fmt.Errorf("IPP printer URL required")
	}
	u, err := normalizeIPPURL(rawURL)
	if err != nil {
		return nil, err
	}
	return &IPPPrinter{URL: u, Name: name}, nil
}

func normalizeIPPURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("empty IPP URL")
	}
	// Handle bare host:port or host without scheme for manual network entry (e.g., 192.168.1.60:631)
	if !strings.Contains(raw, "://") {
		if _, _, err := net.SplitHostPort(raw); err == nil {
			raw = "http://" + raw + "/ipp/print"
		} else if net.ParseIP(strings.Trim(raw, "[]")) != nil {
			raw = "http://" + raw + ":631/ipp/print"
		} else if strings.Contains(raw, ".") && !strings.Contains(raw, "/") {
			// Hostname without port/path
			raw = "http://" + raw + ":631/ipp/print"
		} else if !strings.HasPrefix(strings.ToLower(raw), "http") {
			raw = "http://" + raw
		}
	}
	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, "ipp://") {
		raw = "http://" + raw[6:]
	} else if strings.HasPrefix(lower, "ipps://") {
		raw = "https://" + raw[7:]
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("invalid IPP URL %q: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("IPP URL scheme must be http/https/ipp/ipps, got %q", u.Scheme)
	}
	if u.Host == "" {
		return "", fmt.Errorf("IPP URL host missing")
	}
	// Default path if empty
	if u.Path == "" || u.Path == "/" {
		u.Path = "/ipp/print"
	}
	return u.String(), nil
}

// Print sends document data via IPP Print-Job operation.
// It builds a minimal IPP 2.0 Print-Job request with document-format application/octet-stream
// and appends the raw document bytes. Success is IPP status 0x0000.
func (p *IPPPrinter) Print(ctx context.Context, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("payload %d exceeds %d limit", len(data), maxPrintBytes)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	return p.printDocument(ctx, data, ippFormatOctetStream)
}

// PrintDocument sends the document with the IPP document-format that matches
// the payload kind: application/pdf for PDF (so the printer renders it) and
// application/octet-stream for raw/ESC-POS byte streams.
func (p *IPPPrinter) PrintDocument(ctx context.Context, doc Document) error {
	kind := NormalizeKind(doc.Kind)
	format, ok := ippDocumentFormatFor(kind)
	if !ok {
		return CapabilityMismatchf("IPP printer %s cannot render %s payloads", p.URL, kind)
	}
	if kind == KindPDF {
		if err := ValidatePDF(doc.Data); err != nil {
			return err
		}
	}
	if len(doc.Data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	if len(doc.Data) > maxPrintBytes {
		return fmt.Errorf("payload %d exceeds %d limit", len(doc.Data), maxPrintBytes)
	}
	return p.printDocument(ctx, doc.Data, format)
}

// SupportsKind: IPP carries a typed document, so raw/escpos byte streams and
// real PDF documents are all valid.
func (p *IPPPrinter) SupportsKind(kind string) bool {
	_, ok := ippDocumentFormatFor(NormalizeKind(kind))
	return ok
}

func ippDocumentFormatFor(kind string) (string, bool) {
	switch kind {
	case KindPDF:
		return ippFormatPDF, true
	case KindRaw, KindESCPOS:
		return ippFormatOctetStream, true
	default:
		return "", false
	}
}

func (p *IPPPrinter) printDocument(ctx context.Context, data []byte, documentFormat string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	ippReq := buildIPPPrintJobWithFormat(p.URL, data, documentFormat)
	req, err := http.NewRequestWithContext(ctx, "POST", p.URL, bytes.NewReader(ippReq))
	if err != nil {
		return fmt.Errorf("IPP create request for %s: %w", p.URL, err)
	}
	req.Header.Set("Content-Type", "application/ipp")
	req.Header.Set("Accept", "application/ipp")
	// Some printers require Expect handling, disable
	req.Header.Set("Expect", "")

	client := &http.Client{Timeout: 15 * time.Second}
	// Respect context timeout if set, otherwise 15s
	if deadline, ok := ctx.Deadline(); ok {
		timeout := time.Until(deadline)
		if timeout < 15*time.Second && timeout > 0 {
			client.Timeout = timeout
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("IPP POST to %s failed: %w", p.URL, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("IPP printer %s returned HTTP %d: %s", p.URL, resp.StatusCode, string(body))
	}
	// Parse IPP response status
	status, msg := parseIPPStatus(body)
	if status != 0x0000 {
		return fmt.Errorf("IPP printer %s returned IPP status 0x%04x (%s): %s", p.URL, status, ippStatusText(status), msg)
	}
	log.Printf("IPP printed %d bytes to %s (IPP status 0x%04x)", len(data), p.URL, status)
	return nil
}

func (p *IPPPrinter) Test(ctx context.Context) error {
	data := []byte("IPP Test Print for Odoo Agent - Printer: " + p.Name + "\n\n")
	// Try as raw text; for IPP we send as document-format application/octet-stream
	return p.Print(ctx, data)
}

func (p *IPPPrinter) Status() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Try Get-Printer-Attributes
	attrs, err := p.getPrinterAttributes(ctx)
	if err != nil {
		// Fallback: try simple HTTP GET to URL root
		// If IPP not responding, try TCP dial to host:port
		return "offline"
	}
	if attrs == nil {
		return "online"
	}
	// Check printer-state
	if state, ok := attrs["printer-state"]; ok {
		// 3=idle, 4=processing, 5=stopped
		switch state {
		case "3":
			return "online"
		case "4":
			return "busy"
		case "5":
			return "offline"
		}
	}
	if stateReasons, ok := attrs["printer-state-reasons"]; ok {
		if strings.Contains(stateReasons, "offline") || strings.Contains(stateReasons, "shutdown") {
			return "offline"
		}
		if strings.Contains(stateReasons, "media-needed") || strings.Contains(stateReasons, "toner-empty") {
			return "error"
		}
	}
	return "online"
}

func (p *IPPPrinter) getPrinterAttributes(ctx context.Context) (map[string]string, error) {
	ippReq := buildIPPGetPrinterAttributes(p.URL)
	req, err := http.NewRequestWithContext(ctx, "POST", p.URL, bytes.NewReader(ippReq))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/ipp")
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	status, _ := parseIPPStatus(body)
	if status != 0x0000 {
		return nil, fmt.Errorf("IPP status 0x%04x", status)
	}
	// Parse attributes from response (very minimal)
	attrs := parseIPPAttributes(body)
	return attrs, nil
}

// IPP encoding helpers

const (
	ippFormatOctetStream = "application/octet-stream"
	ippFormatPDF         = "application/pdf"
)

func buildIPPPrintJob(printerURI string, document []byte) []byte {
	return buildIPPPrintJobWithFormat(printerURI, document, ippFormatOctetStream)
}

func buildIPPPrintJobWithFormat(printerURI string, document []byte, documentFormat string) []byte {
	var buf bytes.Buffer
	// Version 2.0
	buf.Write([]byte{0x02, 0x00})
	// Operation Print-Job 0x0002
	binary.Write(&buf, binary.BigEndian, uint16(0x0002))
	// Request ID
	binary.Write(&buf, binary.BigEndian, uint32(1))
	// Operation attributes group 0x01
	buf.WriteByte(0x01)
	writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
	writeIPPAttribute(&buf, 0x48, "attributes-natural-language", "en")
	writeIPPAttribute(&buf, 0x45, "printer-uri", printerURI)
	writeIPPAttribute(&buf, 0x42, "requesting-user-name", "odoo-agent")
	writeIPPAttribute(&buf, 0x49, "document-format", documentFormat)
	writeIPPAttribute(&buf, 0x42, "job-name", "Odoo Print Job")
	// End of attributes
	buf.WriteByte(0x03)
	// Document data
	buf.Write(document)
	return buf.Bytes()
}

func buildIPPGetPrinterAttributes(printerURI string) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00})
	binary.Write(&buf, binary.BigEndian, uint16(0x000B)) // Get-Printer-Attributes
	binary.Write(&buf, binary.BigEndian, uint32(1))
	buf.WriteByte(0x01)
	writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
	writeIPPAttribute(&buf, 0x48, "attributes-natural-language", "en")
	writeIPPAttribute(&buf, 0x45, "printer-uri", printerURI)
	writeIPPAttribute(&buf, 0x42, "requesting-user-name", "odoo-agent")
	// Requested attributes
	writeIPPAttribute(&buf, 0x44, "requested-attributes", "printer-state")
	writeIPPAttribute(&buf, 0x44, "requested-attributes", "printer-state-reasons")
	writeIPPAttribute(&buf, 0x44, "requested-attributes", "printer-is-accepting-jobs")
	buf.WriteByte(0x03)
	return buf.Bytes()
}

func writeIPPAttribute(buf *bytes.Buffer, tag byte, name, value string) {
	buf.WriteByte(tag)
	binary.Write(buf, binary.BigEndian, uint16(len(name)))
	buf.WriteString(name)
	binary.Write(buf, binary.BigEndian, uint16(len(value)))
	buf.WriteString(value)
}

func parseIPPStatus(data []byte) (uint16, string) {
	if len(data) < 8 {
		return 0xFFFF, "too short"
	}
	status := binary.BigEndian.Uint16(data[2:4])
	attrs := parseIPPAttributes(data)
	if msg := attrs["status-message"]; msg != "" {
		return status, msg
	}
	return status, ""
}

// parseIPPAttributes is a bounds-checked IPP binary attribute parser.
// It never panics on truncated, malformed or unknown input: any attribute
// that cannot be decoded is skipped and parsing stops at the first illegal
// length. Repeated values for the same name are joined with commas.
func parseIPPAttributes(data []byte) (out map[string]string) {
	out = make(map[string]string)
	defer func() {
		// Parser must never panic on malformed input.
		if recover() != nil {
			return
		}
	}()
	if len(data) < 8 {
		return out
	}
	i := 8 // skip version (2) + status/op (2) + request-id (4)
	currentName := ""
	for i < len(data) {
		tag := data[i]
		i++
		if tag == 0x03 { // end-of-attributes
			break
		}
		if tag <= 0x0F {
			// Delimiter / group tag (operation, job, printer, unsupported).
			currentName = ""
			continue
		}
		if i+2 > len(data) {
			break
		}
		nameLen := int(binary.BigEndian.Uint16(data[i : i+2]))
		i += 2
		if nameLen < 0 || i+nameLen > len(data) {
			break
		}
		if nameLen > 0 {
			currentName = string(data[i : i+nameLen])
		}
		i += nameLen
		if i+2 > len(data) {
			break
		}
		valueLen := int(binary.BigEndian.Uint16(data[i : i+2]))
		i += 2
		if valueLen < 0 || i+valueLen > len(data) {
			break
		}
		raw := data[i : i+valueLen]
		i += valueLen
		if currentName == "" {
			continue
		}
		val := decodeIPPValue(tag, raw)
		if val == "" {
			continue
		}
		if existing, ok := out[currentName]; ok && existing != "" {
			out[currentName] = existing + "," + val
		} else {
			out[currentName] = val
		}
	}
	return out
}

func decodeIPPValue(tag byte, raw []byte) string {
	switch tag {
	case 0x10, 0x12, 0x13: // unsupported / unknown / no-value
		return ""
	case 0x21, 0x23: // integer / enum
		if len(raw) != 4 {
			return ""
		}
		return fmt.Sprintf("%d", int32(binary.BigEndian.Uint32(raw)))
	case 0x22: // boolean
		if len(raw) != 1 {
			return ""
		}
		if raw[0] != 0 {
			return "true"
		}
		return "false"
	case 0x30, 0x41, 0x42, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49:
		// octetString, textWithoutLanguage, nameWithoutLanguage, keyword,
		// uri, uriScheme, charset, naturalLanguage, mimeMediaType
		return string(raw)
	default:
		// Unknown / unsupported tags: expose printable bytes, otherwise skip.
		for _, b := range raw {
			if b < 0x20 || b > 0x7e {
				return ""
			}
		}
		return string(raw)
	}
}

func ippStatusText(status uint16) string {
	switch status {
	case 0x0000:
		return "successful-ok"
	case 0x0001:
		return "successful-ok-ignored-or-substituted-attributes"
	case 0x0400:
		return "client-error-bad-request"
	case 0x0401:
		return "client-error-forbidden"
	case 0x0402:
		return "client-error-not-authenticated"
	case 0x0403:
		return "client-error-not-authorized"
	case 0x0404:
		return "client-error-not-possible"
	case 0x040A:
		return "client-error-document-format-not-supported"
	case 0x0500:
		return "server-error-internal-error"
	case 0x0501:
		return "server-error-operation-not-supported"
	case 0x0503:
		return "server-error-service-unavailable"
	default:
		return fmt.Sprintf("unknown-0x%04x", status)
	}
}
