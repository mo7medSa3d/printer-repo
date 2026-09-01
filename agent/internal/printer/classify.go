package printer

import (
	"fmt"
	"strings"
)

// classifySpoolerPrinter infers printerType and connectionType from PortName and DriverName.
// Pure function, no Windows API, testable on all platforms.
func classifySpoolerPrinter(portName, driverName, printerName string) (printerType, connectionType string) {
	portLower := ""
	if portName != "" {
		if idx := spoolerIndexComma(portName); idx >= 0 {
			portLower = spoolerToLowerTrim(portName[:idx])
		} else {
			portLower = spoolerToLowerTrim(portName)
		}
	}
	driverLower := spoolerToLowerTrim(driverName)
	nameLower := spoolerToLowerTrim(printerName)

	switch {
	case spoolerHasPrefix(portLower, "usb") || spoolerHasPrefix(portLower, "dot4"):
		connectionType = "usb"
	case spoolerHasPrefix(portLower, "wsd"):
		connectionType = "network"
	case portLower == "lpt1:" || portLower == "com1:" || spoolerHasPrefix(portLower, "lpt") || spoolerHasPrefix(portLower, "com"):
		connectionType = "local"
	case strings.Contains(portLower, "192.168.") || strings.Contains(portLower, "10.") || strings.Contains(portLower, ":9100") || spoolerHasPrefix(portLower, "tcp") || spoolerHasPrefix(portLower, "ip_"):
		connectionType = "network"
	case portLower != "":
		if strings.Contains(portLower, ".") && (strings.Contains(portLower, ":") || spoolerHasPrefix(portLower, "hp") || spoolerHasPrefix(portLower, "canon") || spoolerHasPrefix(portLower, "epson")) {
			connectionType = "network"
		} else {
			connectionType = "spooler"
		}
	default:
		connectionType = "spooler"
	}

	switch {
	case strings.Contains(driverLower, "thermal") || strings.Contains(nameLower, "thermal") || strings.Contains(nameLower, "receipt") || strings.Contains(nameLower, "pos") || strings.Contains(driverLower, "escpos") || strings.Contains(driverLower, "epson tm-") || strings.Contains(driverLower, "bixolon"):
		printerType = "thermal"
	case strings.Contains(driverLower, "label") || strings.Contains(nameLower, "label") || strings.Contains(driverLower, "zebra") || strings.Contains(driverLower, "zdesigner"):
		printerType = "label"
	case strings.Contains(driverLower, "laser") || strings.Contains(nameLower, "laserjet") || strings.Contains(driverLower, "laserjet"):
		printerType = "laser"
	case strings.Contains(driverLower, "inkjet") || strings.Contains(driverLower, "deskjet") || strings.Contains(driverLower, "officejet"):
		printerType = "inkjet"
	default:
		printerType = "unknown"
	}
	return
}

// mapWindowsStatus converts PRINTER_INFO_2.Status bits to our status.
// Pure, testable on all platforms.
func mapWindowsStatus(status uint32, attributes uint32) string {
	const (
		PRINTER_STATUS_PAUSED            = 0x00000001
		PRINTER_STATUS_ERROR             = 0x00000002
		PRINTER_STATUS_PENDING_DELETION  = 0x00000004
		PRINTER_STATUS_PAPER_JAM         = 0x00000008
		PRINTER_STATUS_PAPER_OUT         = 0x00000010
		PRINTER_STATUS_MANUAL_FEED       = 0x00000020
		PRINTER_STATUS_PAPER_PROBLEM     = 0x00000040
		PRINTER_STATUS_OFFLINE           = 0x00000080
		PRINTER_STATUS_IO_ACTIVE         = 0x00000100
		PRINTER_STATUS_BUSY              = 0x00000200
		PRINTER_STATUS_PRINTING          = 0x00000400
		PRINTER_STATUS_OUTPUT_BIN_FULL   = 0x00000800
		PRINTER_STATUS_NOT_AVAILABLE     = 0x00001000
		PRINTER_STATUS_WAITING           = 0x00002000
		PRINTER_STATUS_PROCESSING        = 0x00004000
		PRINTER_STATUS_INITIALIZING      = 0x00008000
		PRINTER_STATUS_WARMING_UP        = 0x00010000
		PRINTER_STATUS_TONER_LOW         = 0x00020000
		PRINTER_STATUS_NO_TONER          = 0x00040000
		PRINTER_STATUS_PAGE_PUNT         = 0x00080000
		PRINTER_STATUS_USER_INTERVENTION = 0x00100000
		PRINTER_STATUS_OUT_OF_MEMORY     = 0x00200000
		PRINTER_STATUS_DOOR_OPEN         = 0x00400000
		PRINTER_STATUS_SERVER_UNKNOWN    = 0x00800000
		PRINTER_STATUS_POWER_SAVE        = 0x01000000
	)
	const PRINTER_ATTRIBUTE_WORK_OFFLINE = 0x00000400
	if attributes&PRINTER_ATTRIBUTE_WORK_OFFLINE != 0 || status&PRINTER_STATUS_OFFLINE != 0 || status&PRINTER_STATUS_NOT_AVAILABLE != 0 || status&PRINTER_STATUS_SERVER_UNKNOWN != 0 {
		return "offline"
	}
	if status&PRINTER_STATUS_ERROR != 0 || status&PRINTER_STATUS_PAPER_JAM != 0 || status&PRINTER_STATUS_PAPER_OUT != 0 || status&PRINTER_STATUS_PAPER_PROBLEM != 0 || status&PRINTER_STATUS_OUTPUT_BIN_FULL != 0 || status&PRINTER_STATUS_NO_TONER != 0 || status&PRINTER_STATUS_DOOR_OPEN != 0 || status&PRINTER_STATUS_USER_INTERVENTION != 0 {
		return "error"
	}
	if status&PRINTER_STATUS_BUSY != 0 || status&PRINTER_STATUS_IO_ACTIVE != 0 || status&PRINTER_STATUS_PRINTING != 0 || status&PRINTER_STATUS_PROCESSING != 0 {
		return "busy"
	}
	if status&PRINTER_STATUS_PAUSED != 0 {
		return "offline"
	}
	if status == 0 {
		return "online"
	}
	return "online"
}

func spoolerToLowerTrim(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	s = s[start:end]
	b := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		b[i] = c
	}
	return string(b)
}
func spoolerHasPrefix(s, prefix string) bool { return len(s) >= len(prefix) && s[:len(prefix)] == prefix }
func spoolerIndexComma(s string) int {
	for i, c := range s {
		if c == ',' {
			return i
		}
	}
	return -1
}
func spoolerSplitPort(s string) (string, string, error) {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == ':' {
			if i == 0 || i == len(s)-1 {
				break
			}
			host := s[:i]
			port := s[i+1:]
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
func spoolerIsIPLike(s string) bool {
	parts := 0
	dots := 0
	for _, c := range s {
		if c == '.' {
			dots++
		} else if c >= '0' && c <= '9' {
			parts++
		} else {
			return false
		}
	}
	return dots == 3 && parts >= 4
}
func spoolerStrconvAtoi(s string) (int, error) {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("invalid int")
		}
		n = n*10 + int(c-'0')
	}
	return n, nil
}
