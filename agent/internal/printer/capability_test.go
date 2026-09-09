package printer

import "testing"

// Cross-layer contract test: this table MUST stay behaviorally identical to
// validatePayloadForPrinter in src/lib/routing.ts and the unknown-protocol
// rule documented in both files. One row per rule; a drift here means a
// payload rejected by one layer and printed by another.
func TestCapabilityTableParity(t *testing.T) {
	cases := []struct {
		name     string
		plType   string
		plProto  string
		devProto string
		conn     string
		caps     []string
		wantOK   bool
	}{
		{"raw device is not a zpl device", "raw", "zpl", "raw", "network", nil, false},
		{"zpl device prints zpl", "raw", "zpl", "zpl", "network", nil, true},
		{"raw device is not an escpos device", "raw", "escpos", "raw", "network", nil, false},
		{"escpos needs escpos declared", "escpos", "escpos", "raw", "network", nil, false},
		{"escpos device prints escpos", "escpos", "escpos", "escpos", "network", nil, true},
		{"tspl device rejects zpl", "raw", "zpl", "tspl", "network", nil, false},
		{"raw payload without protocol is malformed", "raw", "", "zpl", "network", nil, false},
		{"pdf needs a document transport", "pdf", "", "raw", "network", nil, false},
		{"pdf never carries a protocol", "pdf", "raw", "spooler", "spooler", nil, false},
		{"image never carries a protocol", "image", "escpos", "escpos", "network", nil, false},
		{"image is raster-converted by escpos", "image", "", "escpos", "network", nil, true},
		{"image is not printable by ipp without caps", "image", "", "ipp", "ipp", nil, false},
		// Authoritative unknown rule.
		{"unknown+network routes nothing", "raw", "raw", "unknown", "network", nil, false},
		{"unknown+network escpos rejected", "escpos", "escpos", "unknown", "network", nil, false},
		{"unknown+usb escpos rejected", "escpos", "escpos", "unknown", "usb", nil, false},
		{"unknown+network pdf rejected", "pdf", "", "unknown", "network", nil, false},
		{"unknown+network image rejected", "image", "", "unknown", "network", nil, false},
		{"unknown+spooler pdf accepted", "pdf", "", "unknown", "spooler", nil, true},
		{"unknown+spooler image accepted", "image", "", "unknown", "spooler", nil, true},
		{"unknown+ipp pdf accepted", "pdf", "", "unknown", "ipp", nil, true},
		{"unknown+spooler escpos rejected", "escpos", "escpos", "unknown", "spooler", nil, false},
		// Explicit caps are authoritative either way.
		{"declared escpos caps allow escpos on raw pipe", "escpos", "escpos", "raw", "network", []string{"escpos"}, true},
		{"declared pdf caps allow pdf on raw pipe", "pdf", "", "raw", "network", []string{"pdf"}, true},
		{"declared caps cannot smuggle a protocol", "pdf", "raw", "spooler", "spooler", []string{"pdf"}, false},
		// ipp and ipps are the same document transport everywhere checked.
		{"ipps transport prints pdf like ipp", "pdf", "", "ipps", "ipps", nil, true},
		{"declared ipps caps allow pdf", "pdf", "", "raw", "network", []string{"ipps"}, true},
		{"declared ipps caps allow image like ipp", "image", "", "raw", "network", []string{"ipps"}, true},
		{"declared ipp caps allow image", "image", "", "raw", "network", []string{"ipp"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ok, reason := PayloadCompatibleForDevice(tc.plType, tc.plProto, TransportFacts{
				Protocol:          tc.devProto,
				Connection:        tc.conn,
				SupportedProtocol: tc.caps,
			})
			if ok != tc.wantOK {
				t.Fatalf("PayloadCompatibleForDevice(%q,%q on %s/%s caps=%v) = %v (%s), want %v",
					tc.plType, tc.plProto, tc.devProto, tc.conn, tc.caps, ok, reason, tc.wantOK)
			}
		})
	}
}

func TestSupportedProtocolsForUnknownDevices(t *testing.T) {
	if got := SupportedProtocolsForDevice(TransportFacts{Protocol: "unknown", Connection: "network"}); len(got) != 0 {
		t.Fatalf("unknown+network must derive no protocols, got %v", got)
	}
	mustContain := func(facts TransportFacts, want string) {
		t.Helper()
		for _, p := range SupportedProtocolsForDevice(facts) {
			if p == want {
				return
			}
		}
		t.Fatalf("expected %q in %v", want, SupportedProtocolsForDevice(facts))
	}
	mustContain(TransportFacts{Protocol: "unknown", Connection: "spooler"}, "pdf")
	mustContain(TransportFacts{Protocol: "unknown", Connection: "ipp"}, "pdf")
}
