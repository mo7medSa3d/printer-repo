package printer

import (
	"crypto/sha256"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// StableIDFromSpooler derives a deterministic printer ID from Windows spooler name.
// The same spooler name always yields the same ID; the hash prevents leaking
// raw names into IDs and ensures valid ID charset.
func StableIDFromSpooler(spoolerName string) string {
	norm := strings.ToLower(strings.TrimSpace(spoolerName))
	norm = strings.ReplaceAll(norm, " ", "_")
	h := sha256.Sum256([]byte("spooler:" + norm))
	return fmt.Sprintf("printer_spooler_%x", h[:4])
}

// StableIDFromUSB derives a deterministic ID from USB identifiers.
// Priority: serial > location > VID:PID
func StableIDFromUSB(vid, pid, serial, location string) string {
	var key string
	if serial != "" && serial != "0" {
		key = fmt.Sprintf("usb-sn:%s", strings.ToLower(strings.TrimSpace(serial)))
	} else if location != "" {
		key = fmt.Sprintf("usb-loc:%s", strings.ToLower(strings.TrimSpace(location)))
	} else {
		key = fmt.Sprintf("usb-vidpid:%s:%s", strings.ToLower(vid), strings.ToLower(pid))
	}
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("printer_usb_%x", h[:4])
}

// StableIDFromNetwork derives a deterministic ID from IP and port.
func StableIDFromNetwork(ip string, port int) string {
	host := strings.ToLower(strings.TrimSpace(ip))
	// Normalize IP: strip brackets for IPv6
	host = strings.Trim(host, "[]")
	if parsed := net.ParseIP(host); parsed != nil {
		host = parsed.String()
	}
	key := fmt.Sprintf("net:%s:%d", host, port)
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("printer_net_%x", h[:4])
}

// StableIDFromEndpoint derives ID from endpoint string if IP parsing fails.
func StableIDFromEndpoint(endpoint string) string {
	key := fmt.Sprintf("endpoint:%s", strings.ToLower(strings.TrimSpace(endpoint)))
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("printer_ep_%x", h[:4])
}

// StableIDFromUUID derives a deterministic ID from a device UUID.
// A printer UUID is preferable to an IP address because DHCP/network changes
// do not change the physical device identity.
func StableIDFromUUID(uuid string) string {
	norm := strings.ToLower(strings.TrimSpace(uuid))
	h := sha256.Sum256([]byte("uuid:" + norm))
	return fmt.Sprintf("printer_uuid_%x", h[:4])
}

// StableIDForDevice returns deterministic ID based on available fields.
// Priority: UUID > spooler > USB > network (including IPP URL host:port) > endpoint > name
func StableIDForDevice(d DeviceInfo) string {
	if d.Capabilities != nil {
		for _, key := range []string{"uuid", "printer_uuid"} {
			if v, ok := d.Capabilities[key]; ok {
				if uuid := strings.TrimSpace(fmt.Sprint(v)); uuid != "" {
					return StableIDFromUUID(uuid)
				}
			}
		}
	}
	if d.SpoolerName != "" {
		return StableIDFromSpooler(d.SpoolerName)
	}
	if d.USBSerial != "" || d.USBVID != "" {
		return StableIDFromUSB(d.USBVID, d.USBPID, d.USBSerial, "")
	}
	if d.NetworkAddress != "" && d.Port != 0 {
		// For network devices without a stronger identity, fall back to host:port.
		return StableIDFromNetwork(d.NetworkAddress, d.Port)
	}
	if d.Endpoint != "" {
		// Handle IPP URLs: ipp://host:631/ipp/print, http://host:631/...
		lowerEP := strings.ToLower(strings.TrimSpace(d.Endpoint))
		if strings.HasPrefix(lowerEP, "ipp://") || strings.HasPrefix(lowerEP, "ipps://") || strings.HasPrefix(lowerEP, "http://") || strings.HasPrefix(lowerEP, "https://") {
			// Normalize ipp:// -> http:// for parsing
			parseStr := d.Endpoint
			if strings.HasPrefix(lowerEP, "ipp://") {
				parseStr = "http://" + d.Endpoint[6:]
			} else if strings.HasPrefix(lowerEP, "ipps://") {
				parseStr = "https://" + d.Endpoint[7:]
			}
			if u, err := url.Parse(parseStr); err == nil && u.Host != "" {
				host := u.Hostname()
				portStr := u.Port()
				port := 631
				if portStr != "" {
					fmt.Sscanf(portStr, "%d", &port)
				} else {
					if u.Scheme == "https" {
						port = 443
					} else if strings.HasPrefix(lowerEP, "ipps://") {
						port = 631
					}
				}
				if host != "" {
					return StableIDFromNetwork(host, port)
				}
			}
		}
		if host, portStr, err := net.SplitHostPort(d.Endpoint); err == nil {
			var port int
			fmt.Sscanf(portStr, "%d", &port)
			return StableIDFromNetwork(host, port)
		}
		return StableIDFromEndpoint(d.Endpoint)
	}
	h := sha256.Sum256([]byte("name:" + strings.ToLower(d.Name)))
	return fmt.Sprintf("printer_%x", h[:4])
}
