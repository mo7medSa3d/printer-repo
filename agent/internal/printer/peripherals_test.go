package printer

import (
	"bytes"
	"testing"
)

func TestWrapPeripheralCommands_ESCPOS(t *testing.T) {
	doc := []byte("Hello Receipt\n")
	profile := PeripheralProfile{
		DrawerKickMode: "pin2",
		CutterMode:     "full",
		BuzzerMode:     "epson_pulse",
	}

	res := WrapPeripheralCommands(doc, "escpos", profile)

	// Verify drawer kick at start
	if !bytes.HasPrefix(res, DrawerKickPin2) {
		t.Errorf("Expected drawer kick pin 2 at start")
	}

	// Verify buzzer after drawer kick
	expectedPrefix := append(DrawerKickPin2, BuzzerEpson...)
	if !bytes.HasPrefix(res, expectedPrefix) {
		t.Errorf("Expected buzzer chime after drawer kick")
	}

	// Verify cutter at end
	if !bytes.HasSuffix(res, CutterFull) {
		t.Errorf("Expected full cut at end")
	}

	// Verify document content preserved in the middle
	if !bytes.Contains(res, doc) {
		t.Errorf("Document payload missing from wrapped result")
	}
}

func TestWrapPeripheralCommands_ThermalIsolation(t *testing.T) {
	zplDoc := []byte("^XA^FO50,50^ADN,36,20^FDLabel Test^FS^XZ")
	profile := PeripheralProfile{
		DrawerKickMode: "pin2",
		CutterMode:     "full",
		BuzzerMode:     "epson_pulse",
	}

	// For ZPL, peripheral commands must NOT be injected
	res := WrapPeripheralCommands(zplDoc, "zpl", profile)
	if !bytes.Equal(res, zplDoc) {
		t.Errorf("ZPL payload was modified! Peripherals must not be injected into non-thermal streams")
	}

	// For TSPL, peripheral commands must NOT be injected
	tsplDoc := []byte("SIZE 4,2\nGAP 0,0\nTEXT 10,10,\"3\",0,1,1,\"TSPL\"\nPRINT 1\n")
	resTspl := WrapPeripheralCommands(tsplDoc, "tspl", profile)
	if !bytes.Equal(resTspl, tsplDoc) {
		t.Errorf("TSPL payload was modified! Peripherals must not be injected into non-thermal streams")
	}

	// For generic RAW, peripheral commands must NOT be injected
	rawDoc := []byte("GENERIC RAW TEXT\n")
	resRaw := WrapPeripheralCommands(rawDoc, "raw", profile)
	if !bytes.Equal(resRaw, rawDoc) {
		t.Errorf("Generic RAW payload was modified! Peripherals must strictly be ESC/POS only")
	}

	// For PDF, peripheral commands must NOT be injected
	pdfDoc := []byte("%PDF-1.4...")
	resPdf := WrapPeripheralCommands(pdfDoc, "pdf", profile)
	if !bytes.Equal(resPdf, pdfDoc) {
		t.Errorf("PDF payload was modified! Peripherals must not be injected into non-thermal streams")
	}
}
