package printer

import (
	"context"
	"crypto/rand"
	"encoding/xml"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// discoverWSDPrinters performs WS-Discovery multicast probe for network print devices.
func discoverWSDPrinters(ctx context.Context) ([]DeviceInfo, error) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		return nil, fmt.Errorf("net.ListenUDP: %w", err)
	}
	defer conn.Close()

	mcastAddr, err := net.ResolveUDPAddr("udp4", "239.255.255.250:3702")
	if err != nil {
		return nil, fmt.Errorf("resolve multicast address: %w", err)
	}

	probeMsg := buildWSDSOAPProbe()
	if _, err := conn.WriteToUDP(probeMsg, mcastAddr); err != nil {
		return nil, fmt.Errorf("send WSD probe: %w", err)
	}

	deadline := time.Now().Add(2500 * time.Millisecond)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetReadDeadline(deadline)

	buf := make([]byte, 65535)
	var allFound []DeviceInfo
	seenIP := make(map[string]bool)

	for {
		select {
		case <-ctx.Done():
			return deduplicateWSD(allFound), nil
		default:
		}

		n, remoteAddr, err := conn.ReadFromUDP(buf)
		if err != nil {
			break // Read deadline reached or connection closed
		}
		if n == 0 {
			continue
		}

		devs := parseWSDProbeMatches(buf[:n], remoteAddr)
		for _, d := range devs {
			if !seenIP[d.NetworkAddress] {
				seenIP[d.NetworkAddress] = true
				allFound = append(allFound, d)
			}
		}
	}

	return deduplicateWSD(allFound), nil
}

func buildWSDSOAPProbe() []byte {
	msgUUID := generateUUID()
	msg := fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
               xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery"
               xmlns:wsdp="http://schemas.microsoft.com/windows/2006/08/wdp/print"
               xmlns:dn="http://docs.oasis-open.org/ws-dd/ns/discovery/2009/01">
  <soap:Header>
    <wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action>
    <wsa:MessageID>urn:uuid:%s</wsa:MessageID>
    <wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To>
  </soap:Header>
  <soap:Body>
    <wsd:Probe>
      <wsd:Types>wsdp:PrintDeviceType dn:NetworkPrinter</wsd:Types>
    </wsd:Probe>
  </soap:Body>
</soap:Envelope>`, msgUUID)
	return []byte(msg)
}

func generateUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t := time.Now().UnixNano()
		return fmt.Sprintf("%08x-4000-8000-0000-%012x", uint32(t), t&0xffffffffffff)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

type wsdEnvelope struct {
	XMLName xml.Name `xml:"Envelope"`
	Body    wsdBody  `xml:"Body"`
}

type wsdBody struct {
	ProbeMatches wsdProbeMatches `xml:"ProbeMatches"`
}

type wsdProbeMatches struct {
	ProbeMatch []wsdProbeMatch `xml:"ProbeMatch"`
}

type wsdProbeMatch struct {
	EndpointReference wsdEndpointRef `xml:"EndpointReference"`
	Types             string         `xml:"Types"`
	Scopes            string         `xml:"Scopes"`
	XAddrs            string         `xml:"XAddrs"`
}

type wsdEndpointRef struct {
	Address string `xml:"Address"`
}

var (
	reAddress = regexp.MustCompile(`(?i)<(?:[a-zA-Z0-9_\-]+:)?Address[^>]*>([^<]+)</(?:[a-zA-Z0-9_\-]+:)?Address>`)
	reTypes   = regexp.MustCompile(`(?i)<(?:[a-zA-Z0-9_\-]+:)?Types[^>]*>([^<]+)</(?:[a-zA-Z0-9_\-]+:)?Types>`)
	reXAddrs  = regexp.MustCompile(`(?i)<(?:[a-zA-Z0-9_\-]+:)?XAddrs[^>]*>([^<]+)</(?:[a-zA-Z0-9_\-]+:)?XAddrs>`)
)

func parseWSDProbeMatches(data []byte, remoteAddr *net.UDPAddr) []DeviceInfo {
	var env wsdEnvelope
	var out []DeviceInfo

	err := xml.Unmarshal(data, &env)
	if err == nil && len(env.Body.ProbeMatches.ProbeMatch) > 0 {
		for _, match := range env.Body.ProbeMatches.ProbeMatch {
			if !isWSDPrintDevice(match.Types, match.Scopes, string(data)) {
				continue
			}

			ip := extractIPFromXAddrs(match.XAddrs)
			if ip == "" && remoteAddr != nil && remoteAddr.IP != nil {
				ip = remoteAddr.IP.String()
			}
			if ip == "" || net.ParseIP(ip) == nil {
				continue
			}

			epRef := strings.TrimSpace(match.EndpointReference.Address)
			xaddr := strings.TrimSpace(match.XAddrs)
			if f := strings.Fields(xaddr); len(f) > 0 {
				xaddr = f[0]
			}

			caps := map[string]interface{}{
				"wsd_verified":   true,
				"discovered_via": "wsd",
				"wsd_endpoint":   xaddr,
			}
			if epRef != "" {
				caps["endpoint_reference"] = epRef
				caps["uuid"] = strings.TrimPrefix(epRef, "urn:uuid:")
			}

			di := DeviceInfo{
				ID:             StableIDFromNetwork(ip, 9100),
				Name:           fmt.Sprintf("WSD Printer %s", ip),
				DisplayName:    fmt.Sprintf("WSD Printer %s", ip),
				PrinterType:    "unknown",
				ConnectionType: "network",
				Protocol:       "raw",
				Endpoint:       net.JoinHostPort(ip, "9100"),
				NetworkAddress: ip,
				Port:           9100,
				Status:         "online",
				Enabled:        true,
				Type:           "network",
				Capabilities:   caps,
			}
			out = append(out, di)
		}
		if len(out) > 0 {
			return out
		}
	}

	// Fallback regex extraction if XML unmarshal didn't match elements due to custom prefixes
	rawStr := string(data)
	typesVal := ""
	if m := reTypes.FindStringSubmatch(rawStr); len(m) > 1 {
		typesVal = m[1]
	}

	if !isWSDPrintDevice(typesVal, "", rawStr) {
		return nil
	}

	xaddrsVal := ""
	if m := reXAddrs.FindStringSubmatch(rawStr); len(m) > 1 {
		xaddrsVal = m[1]
	}

	ip := extractIPFromXAddrs(xaddrsVal)
	if ip == "" && remoteAddr != nil && remoteAddr.IP != nil {
		ip = remoteAddr.IP.String()
	}
	if ip == "" || net.ParseIP(ip) == nil {
		return nil
	}

	epRef := ""
	if m := reAddress.FindStringSubmatch(rawStr); len(m) > 1 {
		epRef = strings.TrimSpace(m[1])
	}

	xaddr := strings.TrimSpace(xaddrsVal)
	if f := strings.Fields(xaddr); len(f) > 0 {
		xaddr = f[0]
	}

	caps := map[string]interface{}{
		"wsd_verified":   true,
		"discovered_via": "wsd",
		"wsd_endpoint":   xaddr,
	}
	if epRef != "" {
		caps["endpoint_reference"] = epRef
		caps["uuid"] = strings.TrimPrefix(epRef, "urn:uuid:")
	}

	di := DeviceInfo{
		ID:             StableIDFromNetwork(ip, 9100),
		Name:           fmt.Sprintf("WSD Printer %s", ip),
		DisplayName:    fmt.Sprintf("WSD Printer %s", ip),
		PrinterType:    "unknown",
		ConnectionType: "network",
		Protocol:       "raw",
		Endpoint:       net.JoinHostPort(ip, "9100"),
		NetworkAddress: ip,
		Port:           9100,
		Status:         "online",
		Enabled:        true,
		Type:           "network",
		Capabilities:   caps,
	}
	return []DeviceInfo{di}
}

func isWSDPrintDevice(types, scopes, raw string) bool {
	tLower := strings.ToLower(types)
	sLower := strings.ToLower(scopes)
	rLower := strings.ToLower(raw)

	if strings.Contains(tLower, "printdevicetype") ||
		strings.Contains(tLower, "printdevice") ||
		strings.Contains(tLower, "networkprinter") ||
		strings.Contains(tLower, "print") {
		return true
	}
	if strings.Contains(sLower, "print") || strings.Contains(sLower, "printer") {
		return true
	}
	if strings.Contains(rLower, "printdevicetype") || strings.Contains(rLower, "wdp/print") {
		return true
	}
	return false
}

func extractIPFromXAddrs(xaddrs string) string {
	fields := strings.Fields(xaddrs)
	for _, field := range fields {
		u, err := url.Parse(field)
		if err != nil || u.Host == "" {
			continue
		}
		host := u.Hostname()
		if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
			return ip.String()
		}
	}
	return ""
}

func deduplicateWSD(devices []DeviceInfo) []DeviceInfo {
	seen := make(map[string]bool)
	var out []DeviceInfo
	for _, d := range devices {
		if !seen[d.NetworkAddress] {
			seen[d.NetworkAddress] = true
			out = append(out, d)
		}
	}
	return out
}
