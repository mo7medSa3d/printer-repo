package printer

import (
	"fmt"

	"github.com/odoo-print-agent/agent/internal/config"
)

// New builds the concrete Printer backend for a configured printer.
//
// Supported today:
//   - type "network" with protocol "raw" or "escpos": both are transported
//     over raw TCP (e.g. port 9100). The protocol field only affects what
//     bytes the caller sends (plain text vs ESC/POS commands); the
//     transport is identical, which is why both map to NetworkPrinter.
//
// Explicitly NOT supported yet (returns an error, never a fake success):
//   - type "usb": the current backend does not perform real Windows
//     spooler calls yet. Wiring it up to winspool.drv (OpenPrinter /
//     StartDocPrinter / WritePrinter) is planned for a later phase.
//   - type "ipp": no IPP client exists in this project. Do not configure
//     arbitrary office printers expecting RAW TCP on port 9100 to work;
//     most office/laser printers do not accept raw ESC/POS or raw text
//     the way thermal/POS printers do.
func New(cfg config.PrinterConfig) (Printer, error) {
	if cfg.ID == "" {
		return nil, fmt.Errorf("printer config is missing an id")
	}

	switch cfg.Type {
	case "network":
		if cfg.Endpoint == "" {
			return nil, fmt.Errorf("printer %s: network printer requires an endpoint (ip:port)", cfg.ID)
		}
		switch cfg.Protocol {
		case "raw", "escpos", "":
			return &NetworkPrinter{Address: cfg.Endpoint}, nil
		case "ipp":
			return nil, fmt.Errorf("printer %s: protocol \"ipp\" is not implemented; IPP requires a real IPP client, which this agent does not yet have", cfg.ID)
		default:
			return nil, fmt.Errorf("printer %s: unsupported protocol %q for network printer", cfg.ID, cfg.Protocol)
		}

	case "usb":
		return nil, fmt.Errorf("printer %s: USB printing is not yet implemented in this build (see PRINTERS.md); configure it as a network printer or wait for the USB backend phase", cfg.ID)

	case "":
		return nil, fmt.Errorf("printer %s: missing printer type", cfg.ID)

	default:
		return nil, fmt.Errorf("printer %s: unknown printer type %q", cfg.ID, cfg.Type)
	}
}
