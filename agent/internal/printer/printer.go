package printer

import (
	"context"
)

// Printer is the execution backend for a single physical printer.
type Printer interface {
	Print(ctx context.Context, data []byte) error
	Test(ctx context.Context) error
	Status() string
}

// DeviceInfo is the discovery-time description of a physical printer.
// It is used for listing, manual registration, stable-ID persistence, and
// reporting to the Gateway via heartbeat.
type DeviceInfo struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	DisplayName    string `json:"displayName,omitempty"`
	PrinterType    string `json:"printerType,omitempty"`    // thermal/laser/inkjet/other/unknown
	ConnectionType string `json:"connectionType"`            // tcp/usb/spooler/ipp
	Protocol       string `json:"protocol"`                  // raw/escpos/ipp/spooler/windows_spooler
	Endpoint       string `json:"endpoint,omitempty"`        // ip:port or device path
	SpoolerName    string `json:"spoolerName,omitempty"`     // Windows spooler name
	USBVID         string `json:"usbVid,omitempty"`
	USBPID         string `json:"usbPid,omitempty"`
	USBSerial      string `json:"usbSerial,omitempty"`
	NetworkAddress string `json:"networkAddress,omitempty"`
	Port           int    `json:"port,omitempty"`
	Status         string `json:"status"` // online/offline/unknown/busy/error
	Enabled        bool   `json:"enabled"`
	Capabilities   map[string]interface{} `json:"capabilities,omitempty"`
	// Legacy aliases for backward compatibility with heartbeat
	Type string `json:"type,omitempty"`
}

// Capability describes printable capabilities used for validation.
type Capability struct {
	MaxPaperWidth      *int     `json:"max_paper_width,omitempty"`
	SupportsColor      *bool    `json:"supports_color,omitempty"`
	SupportsDuplex     *bool    `json:"supports_duplex,omitempty"`
	SupportedProtocols []string `json:"supported_protocols,omitempty"`
}
