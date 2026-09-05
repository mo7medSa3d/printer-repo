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
	SourceMDNS     = "mdns"
	SourceIPP      = "ipp"
	SourceIPPS     = "ipps"
	SourceRAW      = "raw"
	SourceLPR      = "lpr"
	SourceSNMP     = "snmp"
	SourceWSD      = "wsd"
	SourceSpooler  = "windows_spooler"
	SourceUSB      = "usb"
	SourceSubnet   = "subnet"
	SourceConfig   = "config"
	SourceRegistry = "registry"
)

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
	sysDescr := extractSNMPString(resp)
	if sysDescr == "" {
		return nil
	}
	lower := strings.ToLower(sysDescr)
	isPrinter := strings.Contains(lower, "printer") || strings.Contains(lower, "jetdirect") || strings.Contains(lower, "laser") || strings.Contains(lower, "zebra") || strings.Contains(lower, "epson") || strings.Contains(lower, "brother") || (strings.Contains(lower, "hp") && strings.Contains(lower, "print"))
	if !isPrinter && !strings.Contains(lower, "print") {
		return nil
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
	if parts := strings.Fields(sysDescr); len(parts) >= 2 {
		di.Capabilities["manufacturer"] = parts[0]
	}
	return &di
}

func buildSNMPGet(oids []string) []byte {
	var pdu bytes.Buffer
	pdu.WriteByte(0xA0)
	pduContent := bytes.Buffer{}
	pduContent.Write([]byte{0x02, 0x04, 0x00, 0x00, 0x00, 0x01})
	pduContent.Write([]byte{0x02, 0x01, 0x00})
	pduContent.Write([]byte{0x02, 0x01, 0x00})

	varbinds := bytes.Buffer{}
	for _, oid := range oids {
		oidBytes := encodeOID(oid)
		var vb bytes.Buffer
		vb.WriteByte(0x06)
		writeBERLength(&vb, len(oidBytes))
		vb.Write(oidBytes)
		vb.Write([]byte{0x05, 0x00})

		varbinds.WriteByte(0x30)
		writeBERLength(&varbinds, vb.Len())
		varbinds.Write(vb.Bytes())
	}

	pduContent.WriteByte(0x30)
	writeBERLength(&pduContent, varbinds.Len())
	pduContent.Write(varbinds.Bytes())
	writeBERLength(&pdu, pduContent.Len())
	pdu.Write(pduContent.Bytes())

	var msg bytes.Buffer
	msg.WriteByte(0x30)
	body := bytes.Buffer{}
	body.Write([]byte{0x02, 0x01, 0x00}) // SNMPv1
	body.Write([]byte{0x04, 0x06})
	body.WriteString("public")
	body.Write(pdu.Bytes())
	writeBERLength(&msg, body.Len())
	msg.Write(body.Bytes())
	return msg.Bytes()
}

func writeBERLength(buf *bytes.Buffer, n int) {
	if n < 0 {
		return
	}
	if n < 128 {
		buf.WriteByte(byte(n))
		return
	}
	var tmp [8]byte
	i := len(tmp)
	for n > 0 {
		i--
		tmp[i] = byte(n)
		n >>= 8
	}
	lengthBytes := tmp[i:]
	buf.WriteByte(0x80 | byte(len(lengthBytes)))
	buf.Write(lengthBytes)
}

func encodeOID(s string) []byte {
	parts := strings.Split(strings.TrimSpace(s), ".")
	if len(parts) < 2 {
		return nil
	}
	values := make([]int, len(parts))
	for i, p := range parts {
		if _, err := fmt.Sscanf(p, "%d", &values[i]); err != nil || values[i] < 0 {
			return nil
		}
	}
	if values[0] > 2 || (values[0] < 2 && values[1] >= 40) {
		return nil
	}
	var out []byte
	appendBase128 := func(v int) {
		if v == 0 {
			out = append(out, 0)
			return
		}
		var tmp [8]byte
		i := len(tmp)
		for v > 0 {
			i--
			tmp[i] = byte(v & 0x7F)
			v >>= 7
		}
		for j := i; j < len(tmp)-1; j++ {
			out = append(out, tmp[j]|0x80)
		}
		out = append(out, tmp[len(tmp)-1])
	}
	appendBase128(values[0]*40 + values[1])
	for _, v := range values[2:] {
		appendBase128(v)
	}
	return out
}

func extractSNMPString(data []byte) string {
	targetOID := encodeOID("1.3.6.1.2.1.1.1.0")
	if len(targetOID) == 0 {
		return ""
	}
	for i := 0; i+len(targetOID) < len(data); i++ {
		if !bytes.Equal(data[i:i+len(targetOID)], targetOID) {
			continue
		}
		pos := i + len(targetOID)
		if pos >= len(data) || data[pos] != 0x04 {
			continue
		}
		pos++
		length, next, ok := readBERLength(data, pos)
		if !ok || next+length > len(data) || length == 0 || length > 512 {
			continue
		}
		value := data[next : next+length]
		for _, c := range value {
			if c < 32 || c > 126 {
				return ""
			}
		}
		return string(value)
	}
	return ""
}

func readBERLength(data []byte, pos int) (length, next int, ok bool) {
	if pos >= len(data) {
		return 0, pos, false
	}
	first := data[pos]
	pos++
	if first&0x80 == 0 {
		return int(first), pos, true
	}
	n := int(first & 0x7F)
	if n == 0 || n > 4 || pos+n > len(data) {
		return 0, pos, false
	}
	var v int
	for i := 0; i < n; i++ {
		v = (v << 8) | int(data[pos+i])
	}
	return v, pos + n, true
}

// LPR discovery: safe LPD probe on TCP 515.
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
	_, _ = conn.Write([]byte("\x04raw\n"))
	buf := make([]byte, 256)
	n, _ := conn.Read(buf)
	if n == 0 || buf[0] != 0x00 {
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
		if !bytes.Contains(data, []byte("printer")) && !bytes.Contains(data, []byte("Print")) && !bytes.Contains(data, []byte("wsd")) {
			continue
		}
		ip := remote.IP.String()
		if seenIP[ip] {
			continue
		}
		seenIP[ip] = true
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
	uuid := fmt.Sprintf("urn:uuid:%d", time.Now().UnixNano())
	msg := fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:wprt="http://schemas.microsoft.com/windows/2006/08/wdp/print">
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
	binary.Write(&buf, binary.BigEndian, uint16(0))
	binary.Write(&buf, binary.BigEndian, uint16(0))
	binary.Write(&buf, binary.BigEndian, uint16(1))
	binary.Write(&buf, binary.BigEndian, uint16(0))
	binary.Write(&buf, binary.BigEndian, uint16(0))
	binary.Write(&buf, binary.BigEndian, uint16(0))
	for _, part := range strings.Split(strings.TrimSuffix(service, "."), ".") {
		if len(part) > 63 {
			return nil
		}
		buf.WriteByte(byte(len(part)))
		buf.WriteString(part)
	}
	buf.WriteByte(0)
	binary.Write(&buf, binary.BigEndian, uint16(12))
	binary.Write(&buf, binary.BigEndian, uint16(1))
	return buf.Bytes()
}

func parseMDNSHosts(data []byte) []mdnsHost {
	var hosts []mdnsHost
	s := string(data)
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
	for i := 0; i < len(data)-4; i++ {
		if data[i] == 0x00 && data[i+1] == 0x04 && i+6 <= len(data) {
			ip := net.IPv4(data[i+2], data[i+3], data[i+4], data[i+5])
			if ip.IsPrivate() && !ip.IsLoopback() {
				hosts = append(hosts, mdnsHost{IP: ip.String(), Model: model, UUID: uuid})
				break
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
	if !ipnet.IP.IsPrivate() || ipnet.IP.IsLoopback() {
		return false
	}
	ones, bits := ipnet.Mask.Size()
	if bits != 32 || ones < 16 || ones > 30 {
		return false
	}
	return true
}

func init() {
	_ = extractXMLTag
}
