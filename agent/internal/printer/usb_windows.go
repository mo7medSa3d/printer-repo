//go:build windows

// NOTE (Phase 1 status): this backend is intentionally NOT wired into
// printer.New() yet and must not be treated as functional. Print() and
// Test() return an explicit error rather than a fake success, and
// Status() reports "unknown" rather than lying that the device is online.
// A real implementation (OpenPrinterW/StartDocPrinterW/WritePrinterW via
// winspool.drv) is planned for a later phase and needs to be validated on
// an actual Windows machine, which this development environment does not
// have. Do not remove these honest failure paths without replacing them
// with real spooler calls.
package printer

import (
	"context"
	"fmt"
)

type USBPrinter struct {
	ID           string
	Name         string
	VID          uint16
	PID          uint16
	SerialNumber string
	DevicePath   string
	USBLocation  string
}

// Identify performs layered matching to ensure we are talking to the correct physical printer
func (p *USBPrinter) Identify() string {
	if p.SerialNumber != "" && p.SerialNumber != "0" {
		return fmt.Sprintf("USB-SN:%s", p.SerialNumber)
	}
	if p.USBLocation != "" {
		return fmt.Sprintf("USB-LOC:%s", p.USBLocation)
	}
	return fmt.Sprintf("USB-VIDPID:%04x:%04x", p.VID, p.PID)
}

func (p *USBPrinter) Print(ctx context.Context, data []byte) error {
	return fmt.Errorf("USB printing (%s) is not implemented in this build; no bytes were sent to any device", p.Identify())
}

func (p *USBPrinter) Test(ctx context.Context) error {
	return p.Print(ctx, []byte("\x1b\x40USB Test Print for Odoo Agent\n\n\x1d\x56\x01"))
}

func (p *USBPrinter) Status() string {
	return "unknown"
}
