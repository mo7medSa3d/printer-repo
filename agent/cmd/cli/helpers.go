package main

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/odoo-print-agent/agent/internal/config"
	"github.com/odoo-print-agent/agent/internal/printer"
)

func listPrintersHelper(cfg *config.Config, registryPath string) ([]interface{}, error) {
	infos, err := printer.ListPrinters(cfg, registryPath)
	if err != nil {
		return nil, err
	}
	if len(infos) == 0 {
		return []interface{}{}, nil
	}
	fmt.Printf("%-32s %-24s %-12s %-10s %-8s %-7s %s\n", "ID", "NAME", "TYPE", "PROTO", "STATUS", "ENABLED", "ENDPOINT/SPOOLER")
	fmt.Println("--------------------------------------------------------------------------------------------------------------------------------")
	for _, d := range infos {
		endpoint := d.Endpoint
		if d.SpoolerName != "" {
			endpoint = d.SpoolerName
		}
		if endpoint == "" && d.NetworkAddress != "" {
			if d.Port != 0 {
				endpoint = fmt.Sprintf("%s:%d", d.NetworkAddress, d.Port)
			} else {
				endpoint = d.NetworkAddress
			}
		}
		enabledStr := "true"
		if !d.Enabled {
			enabledStr = "false"
		}
		fmt.Printf("%-32s %-24s %-12s %-10s %-8s %-7s %s\n", d.ID, d.Name, d.ConnectionType, d.Protocol, d.Status, enabledStr, endpoint)
		// Extended fields
		if d.SpoolerName != "" && d.SpoolerName != endpoint {
			fmt.Printf("    spooler=%s\n", d.SpoolerName)
		}
		if d.NetworkAddress != "" {
			fmt.Printf("    network=%s:%d\n", d.NetworkAddress, d.Port)
		}
		if d.USBVID != "" || d.USBPID != "" || d.USBSerial != "" {
			fmt.Printf("    usb vid=%s pid=%s serial=%s\n", d.USBVID, d.USBPID, d.USBSerial)
		}
		if d.PrinterType != "" && d.PrinterType != "unknown" {
			fmt.Printf("    printerType=%s\n", d.PrinterType)
		}
		if len(d.Capabilities) > 0 {
			if b, err := json.Marshal(d.Capabilities); err == nil {
				fmt.Printf("    caps=%s\n", string(b))
			}
		}
		if d.ConnectionType == "usb" && d.SpoolerName == "" {
			fmt.Printf("    ! USB device requires Windows spooler queue for printing\n")
		}
	}
	out := make([]interface{}, len(infos))
	for i, v := range infos {
		out[i] = v
	}
	return out, nil
}

func discoverHelper(cfg *config.Config, registryPath string) []string {
	result := printer.Discover(cfg, registryPath)
	if len(result.Printers) > 0 {
		if _, err := printer.UpsertRegistry(registryPath, result.Printers); err != nil {
			log.Printf("Failed to persist discovery: %v", err)
		}
	}
	fmt.Printf("%-32s %-24s %-12s %-10s %-8s %-7s %s\n", "ID", "NAME", "TYPE", "PROTO", "STATUS", "ENABLED", "ENDPOINT/SPOOLER")
	fmt.Println("--------------------------------------------------------------------------------------------------------------------------------")
	for _, d := range result.Printers {
		endpoint := d.Endpoint
		if d.SpoolerName != "" {
			endpoint = d.SpoolerName
		}
		if endpoint == "" && d.NetworkAddress != "" {
			if d.Port != 0 {
				endpoint = fmt.Sprintf("%s:%d", d.NetworkAddress, d.Port)
			} else {
				endpoint = d.NetworkAddress
			}
		}
		enabledStr := "true"
		if !d.Enabled {
			enabledStr = "false"
		}
		fmt.Printf("%-32s %-24s %-12s %-10s %-8s %-7s %s\n", d.ID, d.Name, d.ConnectionType, d.Protocol, d.Status, enabledStr, endpoint)
		if d.NetworkAddress != "" {
			fmt.Printf("    network=%s:%d\n", d.NetworkAddress, d.Port)
		}
		if d.USBVID != "" {
			fmt.Printf("    usb vid=%s pid=%s serial=%s\n", d.USBVID, d.USBPID, d.USBSerial)
		}
		if len(d.Capabilities) > 0 {
			if b, err := json.Marshal(d.Capabilities); err == nil {
				fmt.Printf("    caps=%s\n", string(b))
			}
		}
	}
	if len(result.Errors) > 0 {
		fmt.Println("Warnings:")
		for _, e := range result.Errors {
			fmt.Printf("  ! %s\n", e)
		}
	}
	ids := make([]string, len(result.Printers))
	for i, p := range result.Printers {
		ids[i] = p.ID
	}
	return ids
}

func testPrinterHelper(cfg *config.Config, registryPath, printerID string) error {
	return printer.TestPrinter(cfg, registryPath, printerID)
}

func addPrinterHelper(cfg *config.Config, registryPath string, info struct {
	ID             string
	Name           string
	ConnectionType string
	PrinterType    string
	Endpoint       string
	Protocol       string
	SpoolerName    string
	USBVID         string
	USBPID         string
	USBSerial      string
	Enabled        bool
	Capabilities   map[string]interface{}
}) error {
	di := printer.DeviceInfo{
		ID:             info.ID,
		Name:           info.Name,
		DisplayName:    info.Name,
		PrinterType:    info.PrinterType,
		ConnectionType: info.ConnectionType,
		Protocol:       info.Protocol,
		Endpoint:       info.Endpoint,
		SpoolerName:    info.SpoolerName,
		USBVID:         info.USBVID,
		USBPID:         info.USBPID,
		USBSerial:      info.USBSerial,
		Status:         "unknown",
		Enabled:        info.Enabled,
		Capabilities:   info.Capabilities,
		Type:           info.ConnectionType,
	}
	if di.PrinterType == "" {
		di.PrinterType = "unknown"
	}
	if di.ConnectionType == "spooler" && di.SpoolerName == "" {
		di.SpoolerName = di.Endpoint
	}
	if di.ID == "" {
		di.ID = printer.StableIDForDevice(di)
	}
	_, err := printer.RegisterManual(registryPath, di)
	return err
}

func removePrinterHelper(registryPath, printerID string) error {
	return printer.RemoveFromRegistry(registryPath, printerID)
}
