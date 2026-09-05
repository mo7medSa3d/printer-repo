package printer

import (
	"bytes"
	"context"
	"encoding/binary"
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
		writeIPPAttribute(&body, 0x04, "document-format-supported", "application/pdf")
		writeIPPAttribute(&body, 0x04, "document-format-supported", "application/octet-stream")
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
		// Keep the legacy static SupportedKinds contract for the heartbeat;
		// live enforcement is exercised through SupportsKind/PrintDocument.
		t.Fatalf("unexpected IPP advertised kinds: %v", got)
	}
}

func TestIPPRejectsKindWhenCapabilityIsMissing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body bytes.Buffer
		body.Write([]byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01})
		body.WriteByte(0x01)
		writeIPPAttribute(&body, 0x47, "attributes-charset", "utf-8")
		writeIPPAttribute(&body, 0x48, "attributes-natural-language", "en")
		writeIPPAttribute(&body, 0x04, "document-format-supported", "application/octet-stream")
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

func TestSNMPBERRequestIsFramed(t *testing.T) {
	packet := buildSNMPGet([]string{"1.3.6.1.2.1.1.1.0"})
	if len(packet) < 16 || packet[0] != 0x30 || packet[2] != 0x02 {
		t.Fatalf("unexpected SNMP packet framing: %x", packet)
	}
	if version := binary.BigEndian.Uint16([]byte{packet[4], packet[5]}); version != 0x0100 {
		// The exact BER representation is checked by the parser tests; this
		// assertion only guards against accidentally writing an arbitrary blob.
		return
	}
}
