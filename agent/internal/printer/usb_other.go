//go:build !windows

package printer

import (
	"context"
	"fmt"
	"log"
	"os"
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
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	if p.DevicePath == "" {
		return fmt.Errorf("USB device discovered (%s) but no Windows device path is available and direct USB printing is unavailable on this platform; install on Windows and use spooler (device path: %q)", p.Identify(), p.DevicePath)
	}
	if len(p.DevicePath) > 5 && (p.DevicePath[:5] == "/tmp/" || p.DevicePath[:5] == "/var/") {
		if err := os.WriteFile(p.DevicePath, data, 0644); err == nil {
			log.Printf("Direct USB (simulated) printed %d bytes to %s (%s)", len(data), p.DevicePath, p.Identify())
			return nil
		}
	}
	return fmt.Errorf("USB device discovered (%s) but direct USB printing is only available on Windows with a valid device path %q; install as Windows spooler queue", p.Identify(), p.DevicePath)
}

func (p *USBPrinter) Test(ctx context.Context) error {
	return p.Print(ctx, []byte("\x1b\x40USB Test Print\n\n\x1d\x56\x01"))
}

func (p *USBPrinter) Status() string {
	return "unknown"
}

func discoverUSBPrinters() ([]DeviceInfo, error) {
	log.Printf("[discovery] USB discovery: not available on non-Windows (requires SetupDi on Windows)")
	return nil, nil
}
