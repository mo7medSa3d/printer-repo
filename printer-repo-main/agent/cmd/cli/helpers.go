package main

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/odoo-print-agent/agent/internal/config"
	"github.com/odoo-print-agent/agent/internal/printer"
)

func discoverHelper(cfg *config.Config, registryPath string, jsonOutput bool) []printer.DeviceInfo {
	result := printer.Discover(cfg, registryPath)
	if len(result.Printers) > 0 {
		if _, err := printer.UpsertRegistry(registryPath, result.Printers); err != nil {
			log.Printf("Failed to persist discovery: %v", err)
		}
	}
	if jsonOutput {
		return result.Printers
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
	return result.Printers
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
