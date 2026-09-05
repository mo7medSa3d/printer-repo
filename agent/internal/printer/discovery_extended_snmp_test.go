package printer

import (
	"bytes"
	"testing"
)

func TestBuildSNMPGetUsesCorrectBERLengths(t *testing.T) {
	data := buildSNMPGet([]string{
		"1.3.6.1.2.1.1.1.0",
		"1.3.6.1.2.1.1.5.0",
	})
	if len(data) < 10 || data[0] != 0x30 {
		t.Fatalf("invalid SNMP message")
	}
	length, next, ok := readBERLength(data, 1)
	if !ok || next+length != len(data) {
		t.Fatalf("top-level BER length mismatch: length=%d next=%d total=%d", length, next, len(data))
	}
	if !bytes.Contains(data, encodeOID("1.3.6.1.2.1.1.1.0")) {
		t.Fatalf("sysDescr OID missing")
	}
	if !bytes.Contains(data, encodeOID("1.3.6.1.2.1.1.5.0")) {
		t.Fatalf("sysName OID missing")
	}
}

func TestExtractSNMPStringReturnsSysDescrNotCommunity(t *testing.T) {
	oid := encodeOID("1.3.6.1.2.1.1.1.0")
	response := []byte{0x30, 0x00}
	response = append(response, []byte("public")...)
	response = append(response, oid...)
	response = append(response, 0x04, byte(len("HP LaserJet Printer")))
	response = append(response, []byte("HP LaserJet Printer")...)

	got := extractSNMPString(response)
	if got != "HP LaserJet Printer" {
		t.Fatalf("got %q want %q", got, "HP LaserJet Printer")
	}
}
