package printer

import (
	"fmt"

	"github.com/odoo-print-agent/agent/internal/config"
)

// New builds the concrete Printer backend for a configured printer.
//
// Supported:
//   - type "network"/"tcp" with protocol "raw" or "escpos": RAW TCP (9100)
//   - type "spooler": Windows Print Spooler via winspool.drv (or stub on non-Windows)
//   - type "usb": USB printers exposed via Windows spooler fall back to spooler backend;
//     raw USB transport is used only when spooler name is not available.
//   - type "ipp": gracefully rejected (requires IPP client) — no fake success.
func New(cfg config.PrinterConfig) (Printer, error) {
	if cfg.ID == "" {
		return nil, fmt.Errorf("printer config is missing an id")
	}

	t := cfg.NormalizedType()
	proto := cfg.NormalizedProtocol()

	switch t {
	case "network":
		if cfg.Endpoint == "" {
			return nil, fmt.Errorf("printer %s: network printer requires an endpoint (ip:port)", cfg.ID)
		}
		switch proto {
		case "raw", "escpos", "":
			return &NetworkPrinter{Address: cfg.Endpoint}, nil
		case "ipp", "ipps":
			// Network printer explicitly using IPP protocol -> treat as IPP
			return NewIPPPrinter(cfg.Endpoint, cfg.Name)
		default:
			return nil, fmt.Errorf("printer %s: unsupported protocol %q for network printer", cfg.ID, cfg.Protocol)
		}

	case "spooler":
		spoolerName := cfg.SpoolerName
		if spoolerName == "" {
			spoolerName = cfg.Endpoint
		}
		if spoolerName == "" {
			return nil, fmt.Errorf("printer %s: spooler printer requires spooler_name or endpoint", cfg.ID)
		}
		return NewSpooler(spoolerName, cfg.Name), nil

	case "usb":
		// CASE A: USB device has a Windows spooler queue -> use spooler (preferred)
		if cfg.SpoolerName != "" {
			return NewSpooler(cfg.SpoolerName, cfg.Name), nil
		}
		if cfg.Endpoint != "" && !isNetworkEndpoint(cfg.Endpoint) {
			// Endpoint is spooler name for USB-via-spooler (e.g., "HP LaserJet")
			return NewSpooler(cfg.Endpoint, cfg.Name), nil
		}
		// CASE B: USB device exists as raw USB without spooler queue.
		// Direct USB printing is not reliably implemented without a spooler queue
		// on Windows (requires WinUSB/libusb and raw endpoint). We expose the
		// discovered device via a USBPrinter that reports explicit error on Print,
		// so Gateway inventory shows it as discovered but not printable, with
		// diagnostic guiding to install as Windows printer.
		vid := parseHex16(cfg.USBVID)
		pid := parseHex16(cfg.USBPID)
		return &USBPrinter{
			ID:           cfg.ID,
			Name:         cfg.Name,
			VID:          vid,
			PID:          pid,
			SerialNumber: cfg.USBSerial,
			DevicePath:   cfg.Endpoint,
		}, nil

	case "ipp", "ipps":
		// IPP/IPPS transport - requires URL endpoint
		if cfg.Endpoint == "" {
			return nil, fmt.Errorf("printer %s: IPP printer requires endpoint URL (ipp://host/ipp/print or http://host:631/ipp/print)", cfg.ID)
		}
		return NewIPPPrinter(cfg.Endpoint, cfg.Name)

	case "":
		return nil, fmt.Errorf("printer %s: missing printer type", cfg.ID)

	default:
		return nil, fmt.Errorf("printer %s: unknown printer type %q (expected network/usb/spooler/ipp)", cfg.ID, cfg.Type)
	}
}

func isNetworkEndpoint(ep string) bool {
	// Heuristic: if it contains : and looks like ip:port, treat as network
	if ep == "" {
		return false
	}
	// Windows spooler names typically do not contain colon+port
	if len(ep) > 0 && ep[0] == '\\' {
		return false
	}
	parts := 0
	for _, c := range ep {
		if c == ':' {
			parts++
		}
	}
	if parts == 1 {
		if _, _, err := parseHostPort(ep); err == nil {
			return true
		}
	}
	return false
}

func parseHostPort(ep string) (string, string, error) {
	// local helper to avoid importing net in non-needed path
	return splitHostPort(ep)
}

func splitHostPort(ep string) (string, string, error) {
	for i := len(ep) - 1; i >= 0; i-- {
		if ep[i] == ':' {
			if i == 0 || i == len(ep)-1 {
				break
			}
			host := ep[:i]
			port := ep[i+1:]
			for _, c := range port {
				if c < '0' || c > '9' {
					return "", "", fmt.Errorf("not host:port")
				}
			}
			return host, port, nil
		}
	}
	return "", "", fmt.Errorf("missing port")
}

func parseHex16(s string) uint16 {
	s = trimSpace(s)
	if s == "" {
		return 0
	}
	if len(s) > 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X') {
		s = s[2:]
	}
	var v uint16
	for _, c := range s {
		var val uint16
		switch {
		case c >= '0' && c <= '9':
			val = uint16(c - '0')
		case c >= 'a' && c <= 'f':
			val = uint16(c - 'a' + 10)
		case c >= 'A' && c <= 'F':
			val = uint16(c - 'A' + 10)
		default:
			continue
		}
		v = v*16 + val
	}
	return v
}

func trimSpace(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}
