package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// IPPPrinter implements IPP/IPPS printing via HTTP POST to the printer URI.
// Supports ipp://, ipps://, http://, https:// with path /ipp/print etc.
//
// The IPP path is a DOCUMENT transport: the agent submits PDFs natively
// (document-format application/pdf) and nothing else. Raw byte streams
// (escpos/zpl/tspl/generic raw) are not an IPP document format here —
// sending octet-stream bytes to an IPP queue is exactly the "gibberish
// pages" failure the PDF policy above documents, and the canonical
// capability model (capability.go / src/lib/routing.ts) rejects it pre
// dispatch.
type IPPPrinter struct {
	URL   string // normalized http(s) URL, safe to log (no credentials)
	Name  string
	creds *url.Userinfo // optional basic-auth from the configured URL
}

func NewIPPPrinter(rawURL, name string) (*IPPPrinter, error) {
	if rawURL == "" {
		return nil, fmt.Errorf("IPP printer URL required")
	}
	u, err := normalizeIPPURL(rawURL)
	if err != nil {
		return nil, err
	}
	return &IPPPrinter{URL: u.Redacted(), creds: u.User}, nil
}

func normalizeIPPURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("empty IPP URL")
	}
	if !strings.Contains(raw, "://") {
		if _, _, err := net.SplitHostPort(raw); err == nil {
			raw = "http://" + raw + "/ipp/print"
		} else if net.ParseIP(strings.Trim(raw, "[]")) != nil {
			raw = "http://" + raw + ":631/ipp/print"
		} else if strings.Contains(raw, ".") && !strings.Contains(raw, "/") {
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
		return nil, fmt.Errorf("invalid IPP URL %q: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("IPP URL scheme must be http/https/ipp/ipps, got %q", u.Scheme)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("IPP URL host missing")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("IPP URL must not carry a query or fragment")
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/ipp/print"
	}
	return u, nil
}

func (p *IPPPrinter) requestURL() string {
	u, err := url.Parse(p.URL)
	if err != nil {
		return p.URL
	}
	if p.creds != nil {
		u.User = p.creds
	}
	return u.String()
}

func (p *IPPPrinter) Print(ctx context.Context, data []byte) error {
	// A bare Print with no document kind is treated as a PDF submission and
	// is validated as such — IPP never silently byte-spools unknown formats.
	if err := ValidatePDF(data); err != nil {
		return err
	}
	return p.printDocument(ctx, data, ippFormatPDF)
}

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

func (p *IPPPrinter) SupportsKind(kind string) bool {
	_, ok := ippDocumentFormatFor(NormalizeKind(kind))
	return ok
}

func ippDocumentFormatFor(kind string) (string, bool) {
	switch kind {
	case KindPDF:
		return ippFormatPDF, true
	default:
		return "", false
	}
}

// preDispatchIRErr reports whether a transport error proves the IPP request
// never left the machine (safe retry classification).
func preDispatchIRErr(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Op == "dial" {
		return true
	}
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr)
}

func (p *IPPPrinter) printDocument(ctx context.Context, data []byte, documentFormat string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	ippReq := buildIPPPrintJobWithFormat(p.requestURL(), data, documentFormat)
	req, err := http.NewRequestWithContext(ctx, "POST", p.requestURL(), bytes.NewReader(ippReq))
	if err != nil {
		return fmt.Errorf("IPP create request for %s: %w", p.URL, err)
	}
	req.Header.Set("Content-Type", "application/ipp")
	req.Header.Set("Accept", "application/ipp")
	req.Header.Set("Expect", "")
	if p.creds != nil {
		if pass, ok := p.creds.Password(); ok {
			req.SetBasicAuth(p.creds.Username(), pass)
		}
	}
	client := &http.Client{Timeout: 15 * time.Second}
	if deadline, ok := ctx.Deadline(); ok {
		// Honor the print budget: a large/slow IPP transfer legitimately
		// outlives the 15s stall floor, and the budget context already
		// bounds the whole job. Without this, slow-but-progressing jobs
		// are killed at 15s despite a multi-minute budget.
		if timeout := time.Until(deadline); timeout > 0 {
			client.Timeout = timeout
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		if preDispatchIRErr(err) {
			// Never transmitted: a clean, safely retryable failure.
			return fmt.Errorf("IPP printer %s unreachable (request not sent): %w", p.URL, err)
		}
		// The request may already have reached the device and created a
		// spooled job; the physical outcome is genuinely unknown.
		return fmt.Errorf("%s: IPP submission to %s failed after transmission may have occurred: %w", ErrOutcomeUnknown, p.URL, err)
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode >= 500 {
			return fmt.Errorf("%s: IPP printer %s returned HTTP %d (submission may have been accepted)", ErrOutcomeUnknown, p.URL, resp.StatusCode)
		}
		return fmt.Errorf("IPP printer %s rejected the request with HTTP %d", p.URL, resp.StatusCode)
	}
	if readErr != nil {
		return fmt.Errorf("%s: IPP response from %s was truncated (job state unknown): %w", ErrOutcomeUnknown, p.URL, readErr)
	}
	status, msg := parseIPPStatus(body)
	if status != 0x0000 {
		if status&0xF000 == 0x5000 {
			return fmt.Errorf("%s: IPP printer %s returned server error 0x%04x (%s); the job may be queued (physical outcome unknown)", ErrOutcomeUnknown, p.URL, status, ippStatusText(status))
		}
		return fmt.Errorf("IPP printer %s returned client error 0x%04x (%s): %s", p.URL, status, ippStatusText(status), msg)
	}
	log.Printf("IPP printed %d bytes to %s (IPP status 0x%04x)", len(data), p.URL, status)
	return nil
}

func (p *IPPPrinter) Test(ctx context.Context) error {
	// A local diagnostic test page would need a real PDF document; the agent
	// does not fabricate one. Use the operator-console "send test page"
	// action, which routes a genuine ticket through the gateway.
	return fmt.Errorf("IPP local test page is not supported; send a test print from the Gateway console instead")
}

// Status differentiates transport failure from unsupported status and from
// a genuinely responsive device. A timeout/unreachable maps to "offline"
// (never "online"); an answered query without a usable printer-state maps
// to "unknown" (never "online").
func (p *IPPPrinter) Status() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	attrs, err := p.getPrinterAttributes(ctx)
	if err != nil {
		var netErr net.Error
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
			return "unknown"
		}
		if preDispatchIRErr(err) || errors.Is(err, errIPPStatusUnsupported) {
			if errors.Is(err, errIPPStatusUnsupported) {
				return "unknown"
			}
			return "offline"
		}
		if strings.Contains(err.Error(), "HTTP 4") || strings.Contains(err.Error(), "IPP status") {
			return "unknown"
		}
		return "offline"
	}
	if attrs == nil {
		return "unknown"
	}
	if accepting, ok := attrs["printer-is-accepting-jobs"]; ok && strings.EqualFold(accepting, "false") {
		return "busy"
	}
	if state, ok := attrs["printer-state"]; ok {
		switch state {
		case "3":
			return "online"
		case "4":
			return "busy"
		case "5":
			return "offline"
		}
		return "unknown"
	}
	if reasons, ok := attrs["printer-state-reasons"]; ok {
		lower := strings.ToLower(reasons)
		if strings.Contains(lower, "media-empty") || strings.Contains(lower, "media-needed") || strings.Contains(lower, "cover-open") || strings.Contains(lower, "toner-empty") {
			return "error"
		}
		if strings.Contains(lower, "offline") || strings.Contains(lower, "shutdown") {
			return "offline"
		}
	}
	return "unknown"
}

var errIPPStatusUnsupported = errors.New("get-printer-attributes unsupported")

func (p *IPPPrinter) getPrinterAttributes(ctx context.Context) (map[string]string, error) {
	ippReq := buildIPPGetPrinterAttributes(p.requestURL())
	req, err := http.NewRequestWithContext(ctx, "POST", p.requestURL(), bytes.NewReader(ippReq))
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
	if resp.StatusCode >= 400 && resp.StatusCode < 500 {
		return nil, fmt.Errorf("HTTP %d: %w", resp.StatusCode, errIPPStatusUnsupported)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if readErr != nil {
		return nil, readErr
	}
	status, _ := parseIPPStatus(body)
	if status != 0x0000 {
		return nil, fmt.Errorf("IPP status 0x%04x: %w", status, errIPPStatusUnsupported)
	}
	return parseIPPAttributes(body), nil
}

const (
	ippFormatPDF = "application/pdf"
)

func buildIPPPrintJobWithFormat(printerURI string, document []byte, documentFormat string) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00})
	binary.Write(&buf, binary.BigEndian, uint16(0x0002))
	binary.Write(&buf, binary.BigEndian, uint32(1))
	buf.WriteByte(0x01)
	writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
	writeIPPAttribute(&buf, 0x48, "attributes-natural-language", "en")
	writeIPPAttribute(&buf, 0x45, "printer-uri", printerURI)
	writeIPPAttribute(&buf, 0x42, "requesting-user-name", "odoo-agent")
	writeIPPAttribute(&buf, 0x49, "document-format", documentFormat)
	writeIPPAttribute(&buf, 0x42, "job-name", "Odoo Print Job")
	buf.WriteByte(0x03)
	buf.Write(document)
	return buf.Bytes()
}

func buildIPPGetPrinterAttributes(printerURI string) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00})
	binary.Write(&buf, binary.BigEndian, uint16(0x000B))
	binary.Write(&buf, binary.BigEndian, uint32(1))
	buf.WriteByte(0x01)
	writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
	writeIPPAttribute(&buf, 0x48, "attributes-natural-language", "en")
	writeIPPAttribute(&buf, 0x45, "printer-uri", printerURI)
	writeIPPAttribute(&buf, 0x42, "requesting-user-name", "odoo-agent")
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

func parseIPPAttributes(data []byte) map[string]string {
	out := make(map[string]string)
	defer func() { _ = recover() }()
	if len(data) < 8 {
		return out
	}
	i := 8
	currentName := ""
	for i < len(data) {
		tag := data[i]
		i++
		if tag == 0x03 {
			break
		}
		if tag <= 0x0F {
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
	case 0x10, 0x12, 0x13:
		return ""
	case 0x21, 0x23:
		if len(raw) != 4 {
			return ""
		}
		return fmt.Sprintf("%d", int32(binary.BigEndian.Uint32(raw)))
	case 0x22:
		if len(raw) != 1 {
			return ""
		}
		if raw[0] != 0 {
			return "true"
		}
		return "false"
	case 0x30, 0x41, 0x42, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49:
		return string(raw)
	default:
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
