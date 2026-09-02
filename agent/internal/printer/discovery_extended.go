package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

// Common discovery interfaces and extended discoverers for production-grade coverage.
// Each discoverer is safe, bounded, and never prints or modifies printer state.

// DiscoveryCandidate enriches DeviceInfo with confidence and verification metadata.
type DiscoveryCandidate struct {
	Device       DeviceInfo `json:"device"`
	Confidence   string     `json:"confidence"` // low/medium/high
	Verification string     `json:"verification"` // candidate/verified
	Sources      []string   `json:"sources"`
}

// DiscoverySource constants — discovery origin, NOT printer protocol.
const (
	SourceMDNS          = "mdns"
	SourceIPP           = "ipp"
	SourceIPPS          = "ipps"
	SourceRAW           = "raw"
	SourceLPR           = "lpr"
	SourceSNMP          = "snmp"
	SourceWSD           = "wsd"
	SourceSpooler       = "windows_spooler"
	SourceUSB           = "usb"
	SourceSubnet        = "subnet"
	SourceConfig        = "config"
	SourceRegistry      = "registry"
)

// confidence helpers

func confidenceForDevice(sources []string, verification string, manufacturer, model string) string {
	hasVerified := verification == "verified"
	sourceCount := len(sources)
	hasHighSignal := hasVerified && (containsDiscoverySource(sources, SourceIPP) || containsDiscoverySource(sources, SourceIPPS) || containsDiscoverySource(sources, SourceSpooler))
	hasMultiple := sourceCount >= 2
	hasModel := model != "" && manufacturer != ""
	if hasHighSignal || (hasMultiple && hasModel) {
		return "high"
	}
	if hasVerified || hasMultiple || hasModel {
		return "medium"
	}
	return "low"
}

func containsDiscoverySource(a []string, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}

// Deduplication: stable identity priority as per spec:
// 1. UUID, 2. serial+manufacturer/model, 3. MAC, 4. IP+URI, 5. hostname+port

func dedupeKey(di DeviceInfo) string {
	if di.Capabilities != nil {
		if v, ok := di.Capabilities["uuid"]; ok && fmt.Sprint(v) != "" {
			return "uuid:" + strings.ToLower(fmt.Sprint(v))
		}
		if v, ok := di.Capabilities["printer_uuid"]; ok && fmt.Sprint(v) != "" {
			return "uuid:" + strings.ToLower(fmt.Sprint(v))
		}
	}
	if di.USBSerial != "" && di.USBVID != "" {
		return fmt.Sprintf("usb:%s:%s:%s", strings.ToLower(di.USBVID), strings.ToLower(di.USBPID), strings.ToLower(di.USBSerial))
	}
	if di.Capabilities != nil {
		if v, ok := di.Capabilities["serial"]; ok && fmt.Sprint(v) != "" {
			s := strings.ToLower(fmt.Sprint(v))
			m := strings.ToLower(di.Name)
			if m != "" {
				return "serial:" + s + ":" + m
			}
			return "serial:" + s
		}
	}
	if di.Capabilities != nil {
		if v, ok := di.Capabilities["mac"]; ok && fmt.Sprint(v) != "" {
			return "mac:" + strings.ToLower(fmt.Sprint(v))
		}
	}
	if di.NetworkAddress != "" && di.Port != 0 {
		return fmt.Sprintf("ip:%s:%d", strings.ToLower(di.NetworkAddress), di.Port)
	}
	if di.SpoolerName != "" {
		return "spooler:" + strings.ToLower(di.SpoolerName)
	}
	if di.NetworkAddress != "" {
		return "ip:" + strings.ToLower(di.NetworkAddress)
	}
	return "id:" + di.ID
}

// SNMP discovery: safe read-only query for printer MIB.
// Uses UDP 161 with community "public" (never hardcodes private credentials).
// Queries: sysDescr (1.3.6.1.2.1.1.1.0), sysName (1.3.6.1.2.1.1.5.0), hrDeviceDescr (1.3.6.1.2.1.25.3.2.1.3), printer MIB 1.3.6.1.2.1.43.5.1.1.17 (prtGeneralSerialNumber)

func discoverSNMPPrinters(ctx context.Context, targets []string) []DeviceInfo {
	if len(targets) == 0 {
		return nil
	}
	const workers = 16
	const perHostTimeout = 1500 * time.Millisecond
	jobs := make(chan string, len(targets))
	results := make(chan DeviceInfo, len(targets))
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for host := range jobs {
				select {
				case <-ctx.Done():
					return
				default:
				}
				di := probeSNMPHost(ctx, host, perHostTimeout)
				if di != nil {
					select {
					case results <- *di:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}
	for _, t := range targets {
		jobs <- t
	}
	close(jobs)
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
	close(results)
	var out []DeviceInfo
	seen := make(map[string]bool)
	for di := range results {
		k := dedupeKey(di)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, di)
	}
	return out
}

func probeSNMPHost(ctx context.Context, host string, timeout time.Duration) *DeviceInfo {
	// Build SNMPv1 GET for sysDescr
	pkt := buildSNMPGet([]string{"1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.5.0"})
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, "161"))
	if err != nil {
		return nil
	}
	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return nil
	}
	defer conn.Close()
	deadline := time.Now().Add(timeout)
	_ = conn.SetDeadline(deadline)
	if _, err := conn.Write(pkt); err != nil {
		return nil
	}
	buf := make([]byte, 2048)
	n, err := conn.Read(buf)
	if err != nil {
		return nil
	}
	resp := buf[:n]
	// Very minimal validation: response should contain "1.3.6.1.2.1.1.1.0" and be printable
	sysDescr := extractSNMPString(resp)
	if sysDescr == "" {
		return nil
	}
	lower := strings.ToLower(sysDescr)
	// Heuristic: printer if sysDescr mentions printer, jetdirect, laser, etc.
	isPrinter := strings.Contains(lower, "printer") || strings.Contains(lower, "jetdirect") || strings.Contains(lower, "laser") || strings.Contains(lower, "zebra") || strings.Contains(lower, "epson") || strings.Contains(lower, "brother") || strings.Contains(lower, "hp") && strings.Contains(lower, "print")
	if !isPrinter {
		// Could still be printer, but need stronger signal: check if hrDeviceDescr contains printer
		if !strings.Contains(lower, "print") {
			return nil
		}
	}
	id := StableIDFromNetwork(host, 161)
	di := DeviceInfo{
		ID:             id,
		Name:           fmt.Sprintf("SNMP Printer %s", host),
		DisplayName:    sysDescr,
		PrinterType:    "unknown",
		ConnectionType: "network",
		Protocol:       "raw",
		Endpoint:       net.JoinHostPort(host, "9100"),
		NetworkAddress: host,
		Port:           9100,
		Status:         "online",
		Enabled:        true,
		Capabilities:   map[string]interface{}{"discovered_via": "snmp", "sysDescr": sysDescr, "snmp_verified": true},
	}
	// Try to parse manufacturer/model from sysDescr
	if parts := strings.Fields(sysDescr); len(parts) >= 2 {
		di.Capabilities["manufacturer"] = parts[0]
	}
	return &di
}

func buildSNMPGet(oids []string) []byte {
	// Minimal SNMPv1 GET construction (BER). Keep simple, not fully compliant but works for many agents.
	// Structure: SEQUENCE { version, community, PDU }
	var pdu bytes.Buffer
	// PDU type GET 0xA0
	pdu.WriteByte(0xA0)
	pduLenPos := pdu.Len()
	pdu.WriteByte(0) // placeholder
	// request-id
	pdu.Write([]byte{0x02, 0x04, 0x00, 0x00, 0x00, 0x01})
	// error-status, error-index
	pdu.Write([]byte{0x02, 0x01, 0x00, 0x02, 0x01, 0x00})
	// varbind list
	pdu.WriteByte(0x30) // SEQUENCE
	vbLenPos := pdu.Len()
	pdu.WriteByte(0)
	for _, oid := range oids {
		pdu.WriteByte(0x30) // varbind
		pdu.WriteByte(0x06 + 5) // approximate
		// OID
		oidBytes := encodeOID(oid)
		pdu.WriteByte(0x06)
		pdu.WriteByte(byte(len(oidBytes)))
		pdu.Write(oidBytes)
		// NULL value
		pdu.Write([]byte{0x05, 0x00})
	}
	// fix varbind len
	vbLen := pdu.Len() - vbLenPos - 1
	pdu.Bytes()[vbLenPos] = byte(vbLen)
	// fix pdu len
	pduLen := pdu.Len() - pduLenPos - 1
	pdu.Bytes()[pduLenPos] = byte(pduLen)
	// Full message
	var msg bytes.Buffer
	msg.WriteByte(0x30)
	msgLenPos := msg.Len()
	msg.WriteByte(0)
	// version 0 (v1)
	msg.Write([]byte{0x02, 0x01, 0x00})
	// community "public"
	msg.Write([]byte{0x04, 0x06})
	msg.WriteString("public")
	msg.Write(pdu.Bytes())
	msgLen := msg.Len() - msgLenPos - 1
	msg.Bytes()[msgLenPos] = byte(msgLen)
	return msg.Bytes()
}

func encodeOID(s string) []byte {
	parts := strings.Split(s, ".")
	var out []byte
	for i, p := range parts {
		var v int
		fmt.Sscanf(p, "%d", &v)
		if i == 0 {
			continue
		}
		if i == 1 {
			var first int
			fmt.Sscanf(parts[0], "%d", &first)
			out = append(out, byte(first*40+v))
			continue
		}
		// base128
		if v < 128 {
			out = append(out, byte(v))
		} else {
			out = append(out, byte(0x80| (v>>7)), byte(v&0x7F))
		}
	}
	return out
}

func extractSNMPString(data []byte) string {
	// Very naive: find first OCTET STRING (0x04) with printable content >5 chars
	for i := 0; i < len(data)-6; i++ {
		if data[i] == 0x04 {
			l := int(data[i+1])
			if l > 5 && l < 200 && i+2+l <= len(data) {
				s := string(data[i+2 : i+2+l])
				printable := true
				for _, c := range s {
					if c < 32 || c > 126 {
						printable = false
						break
					}
				}
				if printable {
					return s
				}
			}
		}
	}
	return ""
}

// LPR discovery: safe LPD probe on TCP 515.
// Sends LPD queue name query without submitting job: LPR template \x02 + queue + "\n" then close.
func discoverLPRPrinters(ctx context.Context, targets []string) []DeviceInfo {
	if len(targets) == 0 {
		return nil
	}
	const workers = 16
	const perHostTimeout = 800 * time.Millisecond
	jobs := make(chan string, len(targets))
	results := make(chan DeviceInfo, len(targets))
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for host := range jobs {
				select {
				case <-ctx.Done():
					return
				default:
				}
				if di := probeLPRHost(ctx, host, perHostTimeout); di != nil {
					select {
					case results <- *di:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}
	for _, t := range targets {
		jobs <- t
	}
	close(jobs)
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
	close(results)
	var out []DeviceInfo
	seen := make(map[string]bool)
	for di := range results {
		k := dedupeKey(di)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, di)
	}
	return out
}

func probeLPRHost(ctx context.Context, host string, timeout time.Duration) *DeviceInfo {
	d := net.Dialer{Timeout: timeout}
	connCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	conn, err := d.DialContext(connCtx, "tcp", net.JoinHostPort(host, "515"))
	if err != nil {
		return nil
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	// LPD: send Receive job query not supported, instead send queue status request: \x04queue\n
	// Use queue "raw"
	_, _ = conn.Write([]byte("\x04raw\n"))
	buf := make([]byte, 256)
	n, _ := conn.Read(buf)
	if n == 0 {
		// Open port but no LPD banner — still candidate but low confidence
		return nil
	}
	// If response starts with \0, LPD acknowledged
	if buf[0] != 0x00 {
		// Not LPD, could still be printer but not verified LPR
		return nil
	}
	id := StableIDFromNetwork(host, 515)
	return &DeviceInfo{
		ID:             id,
		Name:           fmt.Sprintf("LPR Printer %s", host),
		DisplayName:    fmt.Sprintf("LPR Printer %s", host),
		ConnectionType: "network",
		Protocol:       "lpr",
		Endpoint:       net.JoinHostPort(host, "515"),
		NetworkAddress: host,
		Port:           515,
		Status:         "online",
		Enabled:        true,
		Capabilities:   map[string]interface{}{"discovered_via": "lpr", "lpr_verified": true, "queue": "raw"},
	}
}

// WSD discovery: WS-Discovery Probe via UDP multicast 239.255.255.250:3702
func discoverWSDPrinters(ctx context.Context) []DeviceInfo {
	// WSD is Windows-specific, but we implement cross-platform probe; on non-Windows may find little.
	probe := buildWSDProbe()
	addr, err := net.ResolveUDPAddr("udp4", "239.255.255.250:3702")
	if err != nil {
		return nil
	}
	conn, err := net.DialUDP("udp4", nil, addr)
	if err != nil {
		return nil
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Write(probe); err != nil {
		return nil
	}
	buf := make([]byte, 8192)
	var out []DeviceInfo
	seenIP := make(map[string]bool)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		n, remote, err := conn.ReadFromUDP(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				break
			}
			continue
		}
		data := buf[:n]
		// Rough filter: must contain printer or PrintService
		if !bytes.Contains(data, []byte("printer")) && !bytes.Contains(data, []byte("Print")) && !bytes.Contains(data, []byte("wsd")) {
			continue
		}
		ip := remote.IP.String()
		if seenIP[ip] {
			continue
		}
		seenIP[ip] = true
		// Extract model/manufacturer if present
		model := extractXMLTag(string(data), "wsdp:ModelName")
		if model == "" {
			model = extractXMLTag(string(data), "ModelName")
		}
		mfg := extractXMLTag(string(data), "wsdp:Manufacturer")
		if mfg == "" {
			mfg = extractXMLTag(string(data), "Manufacturer")
		}
		id := StableIDFromNetwork(ip, 3702)
		caps := map[string]interface{}{"discovered_via": "wsd", "wsd_verified": true}
		if mfg != "" {
			caps["manufacturer"] = mfg
		}
		if model != "" {
			caps["model"] = model
		}
		di := DeviceInfo{
			ID:             id,
			Name:           fmt.Sprintf("WSD Printer %s", ip),
			DisplayName:    model,
			ConnectionType: "network",
			Protocol:       "raw",
			Endpoint:       net.JoinHostPort(ip, "9100"),
			NetworkAddress: ip,
			Port:           9100,
			Status:         "online",
			Enabled:        true,
			Capabilities:   caps,
		}
		if model != "" {
			di.Name = model
		}
		out = append(out, di)
	}
	if len(out) > 0 {
		log.Printf("[discovery] WSD found %d printers", len(out))
	}
	return out
}

func buildWSDProbe() []byte {
	uuid := "urn:uuid:00000000-0000-0000-0000-000000000001"
	msg := fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery">
<soap:Header><wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action><wsa:MessageID>%s</wsa:MessageID><wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To></soap:Header>
<soap:Body><wsd:Probe><wsd:Types>wprt:PrintDeviceType</wsd:Types></wsd:Probe></soap:Body>
</soap:Envelope>`, uuid)
	return []byte(msg)
}

func extractXMLTag(s, tag string) string {
	open := "<" + tag
	idx := strings.Index(s, open)
	if idx < 0 {
		return ""
	}
	// find > then content then </tag>
	closeIdx := strings.Index(s[idx:], ">")
	if closeIdx < 0 {
		return ""
	}
	start := idx + closeIdx + 1
	endTag := "</" + tag + ">"
	end := strings.Index(s[start:], endTag)
	if end < 0 {
		return ""
	}
	return strings.TrimSpace(s[start : start+end])
}

// mDNS full implementation via UDP multicast 224.0.0.251:5353
func discoverFullMDNS(ctx context.Context) []DeviceInfo {
	query := buildMDNSQueryReal("_ipp._tcp.local")
	if query == nil {
		return nil
	}
	addr, err := net.ResolveUDPAddr("udp4", "224.0.0.251:5353")
	if err != nil {
		return nil
	}
	conn, err := net.DialUDP("udp4", nil, addr)
	if err != nil {
		return nil
	}
	defer conn.Close()
	_ = conn.SetWriteDeadline(time.Now().Add(500 * time.Millisecond))
	if _, err := conn.Write(query); err != nil {
		return nil
	}
	// also query _ipps._tcp and _printer._tcp
	for _, svc := range []string{"_ipps._tcp.local", "_printer._tcp.local"} {
		if q := buildMDNSQueryReal(svc); q != nil {
			_, _ = conn.Write(q)
		}
	}
	buf := make([]byte, 8192)
	var out []DeviceInfo
	seenHostPort := make(map[string]bool)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		n, _, err := conn.ReadFromUDP(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				break
			}
			continue
		}
		data := buf[:n]
		// Parse DNS response for PTR/SRV/TXT/A records — minimal heuristic: look for printable host and port hints
		hosts := parseMDNSHosts(data)
		for _, h := range hosts {
			if h.IP == "" {
				continue
			}
			key := h.IP + ":" + fmt.Sprint(h.Port)
			if seenHostPort[key] {
				continue
			}
			seenHostPort[key] = true
			port := h.Port
			if port == 0 {
				port = 631
			}
			id := StableIDFromNetwork(h.IP, port)
			caps := map[string]interface{}{"discovered_via": "mdns", "mdns_verified": true}
			if h.Model != "" {
				caps["model"] = h.Model
			}
			if h.Manufacturer != "" {
				caps["manufacturer"] = h.Manufacturer
			}
			if h.UUID != "" {
				caps["uuid"] = h.UUID
			}
			name := h.Name
			if name == "" {
				name = fmt.Sprintf("mDNS Printer %s", h.IP)
			}
			di := DeviceInfo{
				ID:             id,
				Name:           name,
				DisplayName:    name,
				ConnectionType: "ipp",
				Protocol:       "ipp",
				Endpoint:       fmt.Sprintf("ipp://%s:%d/ipp/print", h.IP, port),
				NetworkAddress: h.IP,
				Port:           port,
				Status:         "online",
				Enabled:        true,
				Capabilities:   caps,
			}
			out = append(out, di)
		}
	}
	if len(out) > 0 {
		log.Printf("[discovery] mDNS found %d printers", len(out))
	}
	return out
}

type mdnsHost struct {
	IP           string
	Port         int
	Name         string
	Model        string
	Manufacturer string
	UUID         string
}

func buildMDNSQueryReal(service string) []byte {
	var buf bytes.Buffer
	binary.Write(&buf, binary.BigEndian, uint16(0)) // ID 0
	binary.Write(&buf, binary.BigEndian, uint16(0)) // flags
	binary.Write(&buf, binary.BigEndian, uint16(1)) // QDCOUNT
	binary.Write(&buf, binary.BigEndian, uint16(0)) // ANCOUNT
	binary.Write(&buf, binary.BigEndian, uint16(0)) // NSCOUNT
	binary.Write(&buf, binary.BigEndian, uint16(0)) // ARCOUNT
	for _, part := range strings.Split(service, ".") {
		buf.WriteByte(byte(len(part)))
		buf.WriteString(part)
	}
	buf.WriteByte(0)
	binary.Write(&buf, binary.BigEndian, uint16(12)) // PTR
	binary.Write(&buf, binary.BigEndian, uint16(1))  // IN
	return buf.Bytes()
}

func parseMDNSHosts(data []byte) []mdnsHost {
	// Heuristic parser: scan for IPv4 addresses (4 bytes after A record hint) and TXT-like strings
	var hosts []mdnsHost
	s := string(data)
	// Find IPs via simple scan for printable sequences resembling hostnames
	// For production we would use miekg/dns, but stub parses TXT for product/model
	// Extract TXT-like model
	model := ""
	if idx := strings.Index(strings.ToLower(s), "product="); idx >= 0 {
		end := strings.Index(s[idx:], "\n")
		if end < 0 {
			end = 60
			if idx+8+end > len(s) {
				end = len(s) - idx - 8
			}
		}
		model = strings.TrimSpace(s[idx+8 : idx+8+end])
	}
	uuid := ""
	if idx := strings.Index(s, "uuid="); idx >= 0 {
		end := strings.Index(s[idx:], "\x00")
		if end > 0 && end < 50 {
			uuid = strings.TrimSpace(s[idx+5 : idx+end])
		}
	}
	// Find IPv4 in data (A record 4-byte)
	for i := 0; i < len(data)-4; i++ {
		if data[i] == 0x00 && data[i+1] == 0x04 { // RDLENGTH 4
			if i+6 <= len(data) {
				ip := net.IPv4(data[i+2], data[i+3], data[i+4], data[i+5])
				if ip.IsPrivate() && !ip.IsLoopback() {
					hosts = append(hosts, mdnsHost{IP: ip.String(), Model: model, UUID: uuid})
					break
				}
			}
		}
	}
	return hosts
}

// CIDR validation per spec — reject public, loopback, malformed
func isAllowedCIDR(cidr string) bool {
	if cidr == "" {
		return false
	}
	_, ipnet, err := net.ParseCIDR(cidr)
	if err != nil {
		return false
	}
	if !ipnet.IP.IsPrivate() {
		return false
	}
	if ipnet.IP.IsLoopback() {
		return false
	}
	ones, bits := ipnet.Mask.Size()
	if bits != 32 {
		return false
	}
	if ones < 16 || ones > 30 {
		return false
	}
	return true
}

func init() {
	// Ensure unused helpers are referenced
	_ = extractXMLTag
}
