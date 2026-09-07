// Every backend must declare its supported document kinds so the gateway can
// route correctly (capabilities.supported_protocols in the heartbeat).
func TestSupportedKindsPerBackend(t *testing.T) {
	cases := []struct {
		name  string
		p     Printer
		kinds []string
	}{
		{"raw tcp", &NetworkPrinter{Address: "127.0.0.1:9100"}, []string{KindRaw, KindESCPOS, KindImage}},
		{"mock spooler", newMockSpoolerPrinter("Test"), []string{KindRaw, KindESCPOS, KindPDF}},
		{"usb", &USBPrinter{ID: "u", Name: "USB"}, []string{KindRaw, KindESCPOS}},
	}
	for _, c := range cases {
		got := SupportedKinds(c.p)
		if fmt.Sprint(got) != fmt.Sprint(c.kinds) {
			t.Fatalf("%s: supported kinds = %v, want %v", c.name, got, c.kinds)
		}
	}

	ipp, err := NewIPPPrinter("ipp://127.0.0.1:631/ipp/print", "IPP")
	if err != nil {
		t.Fatalf("NewIPPPrinter: %v", err)
	}
	if got := SupportedKinds(ipp); fmt.Sprint(got) != fmt.Sprint([]string{KindRaw, KindESCPOS, KindPDF}) {
		t.Fatalf("ipp: supported kinds = %v", got)
	}
	if format, ok := ippDocumentFormatFor(KindPDF); !ok || format != ippFormatPDF {
		t.Fatalf("IPP must send PDF as %s, got %q (ok=%v)", ippFormatPDF, format, ok)
	}
	if format, ok := ippDocumentFormatFor(KindESCPOS); !ok || format != ippFormatOctetStream {
		t.Fatalf("IPP must send ESC/POS as %s, got %q (ok=%v)", ippFormatOctetStream, format, ok)
