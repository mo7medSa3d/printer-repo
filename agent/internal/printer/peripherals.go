package printer

import (
	"bytes"
	"strings"
)

// Peripheral escape sequences for POS thermal printers.
var (
	// ESC p m t1 t2 (Generate pulse)
	// Pin 2: ESC p 0 25 250 -> 0x1B 0x70 0x00 0x19 0xFA
	DrawerKickPin2 = []byte{0x1B, 0x70, 0x00, 0x19, 0xFA}
	// Pin 5: ESC p 1 25 250 -> 0x1B 0x70 0x01 0x19 0xFA
	DrawerKickPin5 = []byte{0x1B, 0x70, 0x01, 0x19, 0xFA}

	// GS V m (Select cut mode and cut paper)
	// Full cut: GS V 65 0 -> 0x1D 0x56 0x41 0x00
	CutterFull = []byte{0x1D, 0x56, 0x41, 0x00}
	// Partial cut: GS V 66 0 -> 0x1D 0x56 0x42 0x00
	CutterPartial = []byte{0x1D, 0x56, 0x42, 0x00}

	// Buzzer chimes
	// Epson internal pulse: ESC p 0 25 250 -> 0x1B 0x70 0x00 0x19 0xFA
	BuzzerEpson = []byte{0x1B, 0x70, 0x00, 0x19, 0xFA}
	// Star Micronics BEL: 0x07
	BuzzerStar = []byte{0x07}
)

// PeripheralProfile specifies the hardware peripheral triggers for a print job.
type PeripheralProfile struct {
	DrawerKickMode string // "pin2", "pin5", or "none"
	CutterMode     string // "partial", "full", or "none"
	BuzzerMode     string // "epson_pulse", "star_bel", or "none"
}

// WrapPeripheralCommands wraps print payload bytes with hardware peripheral sequences.
// Peripherals are device commands, not documents:
// - Pre-Print: Injects cash drawer pulse and buzzer chime bytes IF and ONLY IF protocol is "escpos".
// - Post-Print: Appends configured cutter escape sequence IF and ONLY IF protocol is "escpos".
// - Thermal isolation: For generic raw, vector, or label protocols ("raw", "zpl", "tspl", "pdf"), thermal escape sequences are NEVER injected.
func WrapPeripheralCommands(data []byte, protocol string, profile PeripheralProfile) []byte {
	proto := strings.ToLower(strings.TrimSpace(protocol))
	// Peripherals are strictly ESC/POS sequences. Do not inject into raw, ZPL, TSPL, or PDF streams.
	if proto != "escpos" {
		return data
	}

	var buf bytes.Buffer

	// 1. Pre-print injections (Drawer Kick & Buzzer)
	switch strings.ToLower(strings.TrimSpace(profile.DrawerKickMode)) {
	case "pin2":
		buf.Write(DrawerKickPin2)
	case "pin5":
		buf.Write(DrawerKickPin5)
	}

	switch strings.ToLower(strings.TrimSpace(profile.BuzzerMode)) {
	case "epson_pulse":
		buf.Write(BuzzerEpson)
	case "star_bel":
		buf.Write(BuzzerStar)
	}

	// 2. Primary document payload
	buf.Write(data)

	// 3. Post-print injection (Feed before cutter to clear thermal head)
	switch strings.ToLower(strings.TrimSpace(profile.CutterMode)) {
	case "partial":
		buf.WriteString("\n\n\n\n\n")
		buf.Write(CutterPartial)
	case "full":
		buf.WriteString("\n\n\n\n\n")
		buf.Write(CutterFull)
	}

	return buf.Bytes()
}
