package printer

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

const (
	oidSysDescr               = "1.3.6.1.2.1.1.1.0"
	oidPrtGeneralPrinterName  = "1.3.6.1.2.1.43.5.1.1.16.1"
	oidPrtGeneralSerialNumber = "1.3.6.1.2.1.43.5.1.1.17.1"
)

var snmpPrinterKeywords = []string{
	// NOTE: keep these specific. Short substrings like "pos" or "star"
	// false-positive on ordinary sysDescr text ("composite", "restart",
	// "post", ...), which would list random network gear as printers.
	"printer",
	"laserjet",
	"pagepro",
	"epson",
	"zebra",
	"tsc",
	"receipt",
	"thermal",
	"label",
	"bixolon",
	"xprinter",
	"intermec",
	"citizen",
}

// probeSNMPPrinter probes the given IP address on UDP port 161 for printer SNMP MIBs.
func probeSNMPPrinter(ctx context.Context, ip string) (DeviceInfo, bool) {
	return probeSNMPPrinterWithPort(ctx, ip, 161, 9100)
}

// probeSNMPPrinterWithPort probes the given IP and SNMP port, populating DeviceInfo with printerPort.
func probeSNMPPrinterWithPort(ctx context.Context, ip string, snmpPort int, printerPort int) (DeviceInfo, bool) {
	if snmpPort <= 0 {
		snmpPort = 161
	}
	if printerPort <= 0 {
		printerPort = 9100
	}

	timeout := 600 * time.Millisecond
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	params := &gosnmp.GoSNMP{
		Target:    ip,
		Port:      uint16(snmpPort),
		Community: "public",
		Version:   gosnmp.Version2c,
		Timeout:   timeout,
		Retries:   1,
		Context:   probeCtx,
	}

	if err := params.Connect(); err != nil {
		return DeviceInfo{}, false
	}
	defer params.Conn.Close()

	oids := []string{oidSysDescr, oidPrtGeneralPrinterName, oidPrtGeneralSerialNumber}
	result, err := params.Get(oids)
	if err != nil || result == nil || len(result.Variables) == 0 {
		// Fallback: try querying sysDescr alone in case device errors on printer MIB OIDs
		result, err = params.Get([]string{oidSysDescr})
		if err != nil || result == nil || len(result.Variables) == 0 {
			return DeviceInfo{}, false
		}
	}

	var sysDescr, prtPrinterName, prtSerial string
	for _, pdu := range result.Variables {
		name := strings.TrimPrefix(pdu.Name, ".")
		val := extractSNMPPDUString(pdu)
		switch {
		case strings.HasPrefix(name, "1.3.6.1.2.1.1.1.0"):
			sysDescr = val
		case strings.HasPrefix(name, "1.3.6.1.2.1.43.5.1.1.16"):
			prtPrinterName = val
		case strings.HasPrefix(name, "1.3.6.1.2.1.43.5.1.1.17"):
			prtSerial = val
		}
	}

	sysDescrLower := strings.ToLower(sysDescr)
	isPrinter := false
	if strings.TrimSpace(prtPrinterName) != "" {
		isPrinter = true
	} else {
		for _, kw := range snmpPrinterKeywords {
			if strings.Contains(sysDescrLower, kw) {
				isPrinter = true
				break
			}
		}
	}

	if !isPrinter {
		return DeviceInfo{}, false
	}

	name := strings.TrimSpace(prtPrinterName)
	if name == "" {
		name = strings.TrimSpace(sysDescr)
	}
	if name == "" {
		name = fmt.Sprintf("SNMP Printer %s", ip)
	}

	protocol := inferSNMPProtocol(sysDescrLower, strings.ToLower(name))

	caps := map[string]interface{}{
		"snmp_verified":  true,
		"discovered_via": "snmp",
		"sysDescr":       sysDescr,
		"serial":         prtSerial,
	}

	di := DeviceInfo{
		ID:             StableIDFromNetwork(ip, printerPort),
		Name:           name,
		DisplayName:    name,
		PrinterType:    "unknown",
		ConnectionType: "network",
		Protocol:       protocol,
		Endpoint:       net.JoinHostPort(ip, strconv.Itoa(printerPort)),
		NetworkAddress: ip,
		Port:           printerPort,
		Status:         "online",
		Enabled:        true,
		Type:           "network",
		Capabilities:   caps,
	}

	return di, true
}

func extractSNMPPDUString(pdu gosnmp.SnmpPDU) string {
	switch val := pdu.Value.(type) {
	case string:
		return strings.TrimSpace(val)
	case []byte:
		return strings.TrimSpace(string(val))
	case nil:
		return ""
	default:
		return strings.TrimSpace(fmt.Sprint(val))
	}
}

func inferSNMPProtocol(sysDescrLower, nameLower string) string {
	combined := sysDescrLower + " " + nameLower
	switch {
	case strings.Contains(combined, "zebra") || strings.Contains(combined, "zpl"):
		return "zpl"
	case strings.Contains(combined, "tsc") || strings.Contains(combined, "tspl"):
		return "tspl"
	case strings.Contains(combined, "escpos") || strings.Contains(combined, "esc/pos") ||
		strings.Contains(combined, "pos") || strings.Contains(combined, "receipt") ||
		strings.Contains(combined, "thermal") || strings.Contains(combined, "star"):
		return "escpos"
	default:
		return "raw"
	}
}
