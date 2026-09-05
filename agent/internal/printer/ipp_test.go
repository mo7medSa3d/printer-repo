package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/odoo-print-agent/agent/internal/config"
)

func TestIPPURLNormalization(t *testing.T) {
	cases := []struct {
		in, want string
		shouldErr bool
	}{
		{"ipp://192.168.1.60/ipp/print", "http://192.168.1.60:631/ipp/print", false},
		{"ipps://192.168.1.60/ipp/print", "https://192.168.1.60:631/ipp/print", false},
		{"http://192.168.1.60:631/ipp/print", "http://192.168.1.60:631/ipp/print", false},
		{"https://192.168.1.60:631/ipp/print", "https://192.168.1.60:631/ipp/print", false},
		{"192.168.1.60:631", "http://192.168.1.60:631/ipp/print", false},
		{"192.168.1.60", "http://192.168.1.60:631/ipp/print", false},
		{"", "", true},
	}
	for _, tc := range cases {
		got, err := normalizeIPPURL(tc.in)
		if tc.shouldErr && err == nil {
			t.Errorf("expected error for %q", tc.in)
		}
		if !tc.shouldErr && err != nil {
			t.Errorf("unexpected error for %q: %v", tc.in, err)
		}
		if !tc.shouldErr && got != tc.want {
			t.Errorf("for %q want %q got %q", tc.in, tc.want, got)
		}
	}
}

func TestIPPBuildPrintJob(t *testing.T) {
	url := "http://192.168.1.60/ipp/print"
	data := []byte("hello")
	req := buildIPPPrintJob(url, data)
	if len(req) < 10 {
		t.Fatalf("too short")
	}
	if req[0] != 0x02 || req[1] != 0x00 {
		t.Fatalf("version not 2.0")
	}
	if req[2] != 0x00 || req[3] != 0x02 {
		t.Fatalf("operation not Print-Job")
	}
	if !containsBytes(req, []byte("printer-uri")) {
		t.Fatalf("missing printer-uri")
	}
	if !containsBytes(req, []byte(url)) {
		t.Fatalf("missing url")
	}
	if !bytesHasSuffix(req, data) {
		t.Fatalf("document not at end")
	}
}

func TestIPPPrintWithMockServer(t *testing.T) {
	var received []byte
	var contentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contentType = r.Header.Get("Content-Type")
		body := readAll(r.Body)
		received = body
		resp := []byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x03}
		w.Header().Set("Content-Type", "application/ipp")
		w.WriteHeader(200)
		w.Write(resp)
	}))
	defer server.Close()

	p, err := NewIPPPrinter(server.URL, "Test IPP")
	if err != nil {
		t.Fatalf("NewIPPPrinter: %v", err)
	}
	data := []byte("IPP test data")
	if err := p.Print(context.Background(), data); err != nil {
		t.Fatalf("Print failed: %v", err)
	}
	if contentType != "application/ipp" {
		t.Fatalf("expected Content-Type application/ipp got %q", contentType)
	}
	if !bytesHasSuffix(received, data) {
		t.Fatalf("document not in IPP request")
	}
}

func TestIPPPrintErrorOnBadStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := []byte{0x02, 0x00, 0x04, 0x04, 0x00, 0x00, 0x00, 0x01, 0x03}
		w.Header().Set("Content-Type", "application/ipp")
		w.Write(resp)
	}))
	defer server.Close()
	p, _ := NewIPPPrinter(server.URL, "Test")
	err := p.Print(context.Background(), []byte("data"))
	if err == nil {
		t.Fatalf("expected error for IPP status 0x0404")
	}
	if !strings.Contains(err.Error(), "0x0404") {
		t.Fatalf("expected status in error, got %v", err)
	}
}

func TestFactoryIPP(t *testing.T) {
	cases := []struct {
		typ, endpoint, proto string
		shouldSucceed bool
	}{
		{"ipp", "ipp://192.168.1.60/ipp/print", "ipp", true},
		{"ipps", "ipps://192.168.1.60/ipp/print", "ipps", true},
		{"network", "192.168.1.60:631", "ipp", true},
		{"network", "http://192.168.1.60:631/ipp/print", "ipp", true},
		{"ipp", "", "ipp", false},
	}
	for _, tc := range cases {
		cfg := config.PrinterConfig{ID: "p1", Name: "Test", Type: tc.typ, Endpoint: tc.endpoint, Protocol: tc.proto}
		_, err := New(cfg)
		if tc.shouldSucceed && err != nil {
			t.Errorf("expected success for %+v got %v", tc, err)
		}
		if !tc.shouldSucceed && err == nil {
			t.Errorf("expected failure for %+v", tc)
		}
	}
}

func TestParseIPPAttributesRealistic(t *testing.T) {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00})
	binary.Write(&buf, binary.BigEndian, uint16(0))
	binary.Write(&buf, binary.BigEndian, uint32(1))
	buf.WriteByte(0x01)
	writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
	writeIPPAttribute(&buf, 0x48, "attributes-natural-language", "en")
	writeIPPAttribute(&buf, 0x41, "status-message", "successful-ok")
	buf.WriteByte(0x04)
	writeIPPIntAttr(&buf, 0x23, "printer-state", 3)
	writeIPPAttribute(&buf, 0x44, "printer-state-reasons", "none")
	buf.WriteByte(0x44)
	binary.Write(&buf, binary.BigEndian, uint16(0))
	media := "media-low"
	binary.Write(&buf, binary.BigEndian, uint16(len(media)))
	buf.WriteString(media)
	writeIPPBoolAttr(&buf, "printer-is-accepting-jobs", true)
	writeIPPAttribute(&buf, 0x42, "printer-name", "HP LaserJet")
	writeIPPAttribute(&buf, 0x45, "printer-uri", "ipp://192.168.1.60/ipp/print")
	writeIPPAttribute(&buf, 0x41, "printer-info", "Front desk")
	writeIPPIntAttr(&buf, 0x21, "copies-default", 1)
	writeIPPAttribute(&buf, 0x41, "vendor-extension", "ok")
	buf.WriteByte(0x03)

	attrs := parseIPPAttributes(buf.Bytes())
	if attrs["printer-state"] != "3" {
		t.Fatalf("printer-state=%q want 3", attrs["printer-state"])
	}
	if attrs["printer-is-accepting-jobs"] != "true" {
		t.Fatalf("accepting=%q", attrs["printer-is-accepting-jobs"])
	}
	if attrs["printer-name"] != "HP LaserJet" {
		t.Fatalf("name=%q", attrs["printer-name"])
	}
	if attrs["printer-uri"] != "ipp://192.168.1.60/ipp/print" {
		t.Fatalf("uri=%q", attrs["printer-uri"])
	}
	if attrs["printer-info"] != "Front desk" {
		t.Fatalf("info=%q", attrs["printer-info"])
	}
	if attrs["copies-default"] != "1" {
		t.Fatalf("copies=%q", attrs["copies-default"])
	}
	if !strings.Contains(attrs["printer-state-reasons"], "none") || !strings.Contains(attrs["printer-state-reasons"], "media-low") {
		t.Fatalf("reasons=%q", attrs["printer-state-reasons"])
	}
	if attrs["vendor-extension"] != "ok" {
		t.Fatalf("unknown attr dropped: %v", attrs)
	}
	status, msg := parseIPPStatus(buf.Bytes())
	if status != 0 {
		t.Fatalf("status 0x%04x", status)
	}
	if msg != "successful-ok" {
		t.Fatalf("status-message=%q", msg)
	}
}

func TestParseIPPAttributesMalformedNeverPanics(t *testing.T) {
	cases := [][]byte{
		nil,
		{},
		{0x02, 0x00},
		{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01},
		append([]byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x04, 0x21}, bytes.Repeat([]byte{0xff}, 8)...),
		{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x41, 0x00, 0x20},
		{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x41, 0x00, 0x01, 'a', 0xFF, 0xFF},
		{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x99, 0x00, 0x03, 'f', 'o', 'o', 0x00, 0x01, 0x01},
	}
	for i, c := range cases {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("case %d panicked: %v", i, r)
				}
			}()
			_ = parseIPPAttributes(c)
			_, _ = parseIPPStatus(c)
		}()
	}
}

func TestParseIPPAttributesMultiplePrinterGroups(t *testing.T) {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01})
	buf.WriteByte(0x01)
	writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
	buf.WriteByte(0x04)
	writeIPPIntAttr(&buf, 0x23, "printer-state", 4)
	buf.WriteByte(0x04)
	writeIPPAttribute(&buf, 0x44, "printer-state-reasons", "moving-to-paused")
	buf.WriteByte(0x03)
	attrs := parseIPPAttributes(buf.Bytes())
	if attrs["printer-state"] != "4" {
		t.Fatalf("state=%q", attrs["printer-state"])
	}
	if attrs["printer-state-reasons"] != "moving-to-paused" {
		t.Fatalf("reasons=%q", attrs["printer-state-reasons"])
	}
}

func TestIPPStatusUsesParsedPrinterState(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var buf bytes.Buffer
		buf.Write([]byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01})
		buf.WriteByte(0x01)
		writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
		writeIPPAttribute(&buf, 0x48, "attributes-natural-language", "en")
		buf.WriteByte(0x04)
		writeIPPIntAttr(&buf, 0x23, "printer-state", 3)
		writeIPPAttribute(&buf, 0x44, "printer-state-reasons", "none")
		writeIPPBoolAttr(&buf, "printer-is-accepting-jobs", true)
		buf.WriteByte(0x03)
		w.Header().Set("Content-Type", "application/ipp")
		w.Write(buf.Bytes())
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "State")
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Status(); got != "online" {
		t.Fatalf("status=%q want online", got)
	}
}

func writeIPPIntAttr(buf *bytes.Buffer, tag byte, name string, value int32) {
	buf.WriteByte(tag)
	binary.Write(buf, binary.BigEndian, uint16(len(name)))
	buf.WriteString(name)
	binary.Write(buf, binary.BigEndian, uint16(4))
	binary.Write(buf, binary.BigEndian, value)
}

func writeIPPBoolAttr(buf *bytes.Buffer, name string, value bool) {
	buf.WriteByte(0x22)
	binary.Write(buf, binary.BigEndian, uint16(len(name)))
	buf.WriteString(name)
	binary.Write(buf, binary.BigEndian, uint16(1))
	if value {
		buf.WriteByte(0x01)
	} else {
		buf.WriteByte(0x00)
	}
}

func containsBytes(b, sub []byte) bool {
	for i := 0; i <= len(b)-len(sub); i++ {
		if string(b[i:i+len(sub)]) == string(sub) {
			return true
		}
	}
	return false
}
func bytesHasSuffix(b, suffix []byte) bool {
	if len(suffix) > len(b) {
		return false
	}
	return string(b[len(b)-len(suffix):]) == string(suffix)
}
func readAll(r interface{ Read([]byte) (int, error) }) []byte {
	buf := make([]byte, 0, 512)
	tmp := make([]byte, 512)
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			break
		}
		if n == 0 {
			break
		}
	}
	return buf
}
