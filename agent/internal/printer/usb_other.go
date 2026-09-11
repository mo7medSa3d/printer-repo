//go:build !windows

package printer

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

func discoverUSBPrinters() ([]DeviceInfo, error) {
	log.Printf("[discovery] USB discovery: not available on non-Windows (requires SetupDi on Windows)")
	return nil, nil
}

// USBPrinter on non-Windows platforms has no raw USB printing capability.
// The truthful default is a failure. File writes happen only under the
// explicit ODOO_PRINT_AGENT_ALLOW_SIMULATED_TRANSPORT=1 development opt-in.
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
	if simulatedTransportAllowed() && p.DevicePath != "" && filepath.IsAbs(p.DevicePath) {
		if err := os.WriteFile(p.DevicePath, data, 0600); err != nil {
			return fmt.Errorf("SIMULATED_TRANSPORT: USB write to %s failed: %w", p.DevicePath, err)
		}
		return nil
	}
	return fmt.Errorf("ERR_UNSUPPORTED_TRANSPORT: direct USB printing is only available on Windows with a valid device path; install %s as a Windows spooler queue and route the job there; nothing was sent", p.Identify())
}

func (p *USBPrinter) Test(ctx context.Context) error {
	return p.Print(ctx, []byte("USB Test Print"))
}

func (p *USBPrinter) Status() string {
	if simulatedTransportAllowed() {
		return "online"
	}
	// Unprovable from this platform.
	return "unknown"
}

func (p *USBPrinter) SupportsKind(kind string) bool {
	switch NormalizeKind(kind) {
	case KindRaw, KindESCPOS:
		return true
	default:
		return false
	}
}

func (p *USBPrinter) PrintDocument(ctx context.Context, doc Document) error {
	if !p.SupportsKind(doc.Kind) {
		return CapabilityMismatchf("USB printer %s cannot render %s payloads", p.Name, NormalizeKind(doc.Kind))
	}
	return p.Print(ctx, doc.Data)
}
