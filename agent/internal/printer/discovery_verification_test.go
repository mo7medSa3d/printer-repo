package printer

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIPPRequiresExplicitDocumentFormatCapability(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body bytes.Buffer
		body.Write([]byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01})
		body.WriteByte(0x01)
		writeIPPAttribute(&body, 0x47, "attributes-charset", "utf-8")
		writeIPPAttribute(&body, 0x48, "attributes-natural-language", "en")
		writeIPPAttribute(&body, 0x49, "document-format-supported", "application/pdf")
		writeIPPAttribute(&body, 0x49, "document-format-supported", "application/octet-stream")
		body.WriteByte(0x03)
		w.Header().Set("Content-Type", "application/ipp")
		_, _ = w.Write(body.Bytes())
	}))
	defer server.Close()

	p, err := NewIPPPrinter(server.URL+"/ipp/print", "capability-test")
	if err != nil {
		t.Fatal(err)
	}
	if !SupportsKind(p, KindPDF) {
		t.Fatal("PDF must be accepted when application/pdf is reported")
	}
	if !SupportsKind(p, KindRaw) {
		t.Fatal("raw must be accepted when application/octet-stream is reported")
	}
	if got := SupportedKinds(p); len(got) != 3 {
		t.Fatalf("unexpected static IPP kinds: %v", got)
	}
}

func TestIPPRejectsKindWhenCapabilityIsMissing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body bytes.Buffer
		body.Write([]byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01})
		body.WriteByte(0x01)
		writeIPPAttribute(&body, 0x47, "attributes-charset", "utf-8")
		writeIPPAttribute(&body, 0x48, "attributes-natural-language", "en")
		writeIPPAttribute(&body, 0x49, "document-format-supported", "application/octet-stream")
		body.WriteByte(0x03)
		w.Header().Set("Content-Type", "application/ipp")
		_, _ = w.Write(body.Bytes())
	}))
	defer server.Close()

	p, err := NewIPPPrinter(server.URL+"/ipp/print", "capability-test")
	if err != nil {
		t.Fatal(err)
	}
	if SupportsKind(p, KindPDF) {
		t.Fatal("PDF must be rejected when application/pdf is not reported")
	}
	if err := PrintDocument(context.Background(), p, Document{Kind: KindPDF, Data: validPDF(), JobID: "capability-mismatch"}); err == nil || !IsCapabilityMismatch(err) {
		t.Fatalf("expected CAPABILITY_MISMATCH, got %v", err)
	}
}

func TestUnverifiedNetworkFindingsAreNotProductionPrinters(t *testing.T) {
	d := candidateDevice(
		StableIDFromNetwork("192.168.1.60", 9100),
		"TCP candidate",
		"TCP candidate",
		SourceRAW,
		"low",
		map[string]interface{}{"candidate_host": "192.168.1.60", "candidate_port": 9100},
	)
	if got := d.Capabilities["verification"]; got != "candidate" {
		t.Fatalf("verification=%v want candidate", got)
	}
	if got := d.Capabilities["confidence"]; got != "low" {
		t.Fatalf("confidence=%v want low", got)
	}
	if IsProductionPrinter(d) {
		t.Fatal("unverified network candidate must not be a production printer")
	}
}

func TestSNMPAndWSDFindingsAreCandidates(t *testing.T) {
	for _, d := range []DeviceInfo{
		candidateDevice("snmp-1", "SNMP candidate", "SNMP candidate", SourceSNMP, "medium", nil),
		candidateDevice("wsd-1", "WSD candidate", "WSD candidate", SourceWSD, "medium", nil),
	} {
		if d.Capabilities["verification"] != "candidate" {
			t.Fatalf("%s verification=%v", d.Name, d.Capabilities["verification"])
		}
		if IsProductionPrinter(d) {
			t.Fatalf("%s must not be auto-promoted to production", d.Name)
		}
	}
}

func TestWSDProbeMessageIDLooksLikeUUID(t *testing.T) {
	probe := string(buildWSDProbe())
	if !bytes.Contains([]byte(probe), []byte("urn:uuid:")) {
		t.Fatal("WSD Probe must include a UUID MessageID")
	}
}
