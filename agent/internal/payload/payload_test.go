package payload

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestParseValidRaw(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("hello printer"))
	pl, err := Parse(map[string]interface{}{
		"type":     "raw",
		"protocol": "raw",
		"encoding": "base64",
		"data":     data,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pl.Type != TypeRaw || pl.Protocol != "raw" || string(pl.Data) != "hello printer" {
		t.Fatalf("unexpected payload: %+v", pl)
	}
}

func TestParseValidEscpos(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("\x1b\x40test\x1d\x56\x01"))
	pl, err := Parse(map[string]interface{}{
		"type":     "escpos",
		"protocol": "escpos",
		"encoding": "base64",
		"data":     data,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pl.Type != TypeESCPOS || pl.Protocol != "escpos" {
		t.Fatalf("expected escpos with escpos protocol, got %s / %s", pl.Type, pl.Protocol)
	}
}

func TestParseValidPDF(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 fake"))
	pl, err := Parse(map[string]interface{}{"type": "pdf", "encoding": "base64", "data": data})
	if err != nil {
		t.Fatalf("unexpected error for pdf: %v", err)
	}
	if pl.Type != TypePDF {
		t.Fatalf("expected pdf, got %s", pl.Type)
	}
}

func TestParseInvalidCases(t *testing.T) {
	validData := base64.StdEncoding.EncodeToString([]byte("hello"))
	cases := []struct {
		name string
		raw  interface{}
	}{
		{"nil", nil},
		{"not object", "string"},
		{"missing type", map[string]interface{}{"encoding": "base64", "data": base64.StdEncoding.EncodeToString([]byte("x"))}},
		{"bad type", map[string]interface{}{"type": "badtype", "encoding": "base64", "data": base64.StdEncoding.EncodeToString([]byte("x"))}},
		{"raw missing protocol", map[string]interface{}{"type": "raw", "encoding": "base64", "data": validData}},
		{"raw unsupported protocol", map[string]interface{}{"type": "raw", "protocol": "unknown", "encoding": "base64", "data": validData}},
		{"escpos missing protocol", map[string]interface{}{"type": "escpos", "encoding": "base64", "data": validData}},
		{"escpos incompatible protocol", map[string]interface{}{"type": "escpos", "protocol": "zpl", "encoding": "base64", "data": validData}},
		{"pdf with protocol", map[string]interface{}{"type": "pdf", "protocol": "escpos", "encoding": "base64", "data": base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 fake"))}},
		{"bad encoding", map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "hex", "data": validData}},
		{"missing data", map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "base64"}},
		{"empty data", map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "base64", "data": ""}},
		{"invalid base64", map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "base64", "data": "!!! not base64"}},
		{"empty decoded", map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "base64", "data": base64.StdEncoding.EncodeToString([]byte(""))}},
		{"peripherals with non-escpos", map[string]interface{}{
			"type":     "raw",
			"protocol": "zpl",
			"encoding": "base64",
			"data":     validData,
			"peripherals": map[string]interface{}{
				"cutter": "full",
			},
		}},
	}
	for _, c := range cases {
		_, err := Parse(c.raw)
		if err == nil {
			t.Errorf("case %q expected error, got nil", c.name)
		}
	}
}

func TestParseOversizedPrecheck(t *testing.T) {
	// craft a base64 string that would decode to >5MiB
	huge := strings.Repeat("A", (MaxPayloadBytes/3)*4+20)
	_, err := Parse(map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "base64", "data": huge})
	if err == nil {
		t.Fatalf("expected oversized error")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Fatalf("expected too large, got %v", err)
	}
}

func TestParsePeripherals(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("hello"))
	pl, err := Parse(map[string]interface{}{
		"type":     "raw",
		"protocol": "escpos",
		"encoding": "base64",
		"data":     data,
		"peripherals": map[string]interface{}{
			"drawer": "pin2",
			"cutter": "full",
			"buzzer": "epson_pulse",
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pl.Peripherals.Drawer != "pin2" || pl.Peripherals.Cutter != "full" || pl.Peripherals.Buzzer != "epson_pulse" {
		t.Fatalf("unexpected peripherals: %+v", pl.Peripherals)
	}
}
