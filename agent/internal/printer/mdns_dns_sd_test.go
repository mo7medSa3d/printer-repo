package printer

import (
	"encoding/binary"
	"net"
	"strings"
	"testing"
)

func TestBuildMDNSPTRQuery(t *testing.T) {
	packet, err := buildMDNSPTRQuery("_ipp._tcp.local.")
	if err != nil {
		t.Fatalf("build query: %v", err)
	}
	if len(packet) < 12 {
		t.Fatalf("query too short: %d", len(packet))
	}
	if got := binary.BigEndian.Uint16(packet[4:6]); got != 1 {
		t.Fatalf("qdcount=%d want 1", got)
	}
	if got := binary.BigEndian.Uint16(packet[10:12]); got != 0 {
		t.Fatalf("arcount=%d want 0", got)
	}
	if !strings.Contains(string(packet), "_ipp") {
		t.Fatalf("query does not contain service name")
	}
	if packet[len(packet)-4] != 0x00 || packet[len(packet)-3] != 0x0c || packet[len(packet)-2] != 0x00 || packet[len(packet)-1] != 0x01 {
		t.Fatalf("query does not end with PTR/IN question")
	}
}

func TestParseMDNSPacketWithCompressionAndTXT(t *testing.T) {
	packet := make([]byte, 12)
	binary.BigEndian.PutUint16(packet[4:6], 1) // question
	binary.BigEndian.PutUint16(packet[6:8], 4) // answer

	service := encodeDNSName("_ipp._tcp.local.")
	questionOffset := len(packet)
	packet = append(packet, service...)
	packet = append(packet, 0x00, 0x0c, 0x00, 0x01) // PTR IN

	// PTR: _printer._ipp._tcp.local.
	instance := encodeDNSName("Front Desk._ipp._tcp.local.")
	packet = appendRRName(packet, "_ipp._tcp.local.", 12, 0x8400, instance)

	// SRV: Front Desk._ipp._tcp.local. -> printer.local.:631
	srvRData := make([]byte, 6)
	binary.BigEndian.PutUint16(srvRData[0:2], 0)
	binary.BigEndian.PutUint16(srvRData[2:4], 0)
	binary.BigEndian.PutUint16(srvRData[4:6], 631)
	srvRData = append(srvRData, encodeDNSName("printer.local.")...)
	packet = appendRRName(packet, "Front Desk._ipp._tcp.local.", 33, 0x8400, srvRData)

	// TXT: rp=/ipp/print and ty=Example Printer
	txt := append([]byte{byte(len("rp=/ipp/print"))}, []byte("rp=/ipp/print")...)
	txt = append(txt, byte(len("ty=Example Printer")))
	txt = append(txt, []byte("ty=Example Printer")...)
	packet = appendRRName(packet, "Front Desk._ipp._tcp.local.", 16, 0x8400, txt)

	// A: printer.local. -> 192.168.1.60
	packet = appendRRName(packet, "printer.local.", 1, 0x8400, net.IPv4(192, 168, 1, 60).To4())

	if questionOffset == 0 {
		t.Fatal("question offset unexpectedly zero")
	}
	records := parseMDNSPacket(packet)
	if len(records) != 4 {
		t.Fatalf("records=%d want 4", len(records))
	}

	var ptr, srv, txtRecord, arecord *mdnsRecord
	for i := range records {
		r := &records[i]
		switch r.type_ {
		case 12:
			ptr = r
		case 33:
			srv = r
		case 16:
			txtRecord = r
		case 1:
			arecord = r
		}
	}
	if ptr == nil || ptr.ptr != "Front Desk._ipp._tcp.local" {
		t.Fatalf("PTR=%v", ptr)
	}
	if srv == nil || srv.srv == nil || srv.srv.port != 631 || srv.srv.target != "printer.local" {
		t.Fatalf("SRV=%v", srv)
	}
	if txtRecord == nil || txtRecord.txt["rp"] != "/ipp/print" || txtRecord.txt["ty"] != "Example Printer" {
		t.Fatalf("TXT=%v", txtRecord)
	}
	if arecord == nil || len(arecord.ips) != 1 || !arecord.ips[0].Equal(net.IPv4(192, 168, 1, 60)) {
		t.Fatalf("A=%v", arecord)
	}
}

func TestDecodeDNSNameRejectsLoops(t *testing.T) {
	packet := []byte{0xc0, 0x00}
	if _, _, ok := decodeDNSName(packet, 0); ok {
		t.Fatalf("expected compression loop to be rejected")
	}
}

func appendRRName(packet []byte, name string, type_, class uint16, rdata []byte) []byte {
	packet = append(packet, encodeDNSName(name)...)
	header := make([]byte, 10)
	binary.BigEndian.PutUint16(header[0:2], type_)
	binary.BigEndian.PutUint16(header[2:4], class)
	binary.BigEndian.PutUint32(header[4:8], 120)
	binary.BigEndian.PutUint16(header[8:10], uint16(len(rdata)))
	packet = append(packet, header...)
	return append(packet, rdata...)
}
