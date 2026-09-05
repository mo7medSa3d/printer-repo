package printer

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"sort"
	"strings"
	"time"
)

const (
	mdnsIPv4 = "224.0.0.251"
	mdnsPort = 5353
)

type mdnsRecord struct {
	name  string
	type_ uint16
	data  []byte
	ptr   string
	srv   *mdnsSRV
	txt   map[string]string
	ips   []net.IP
}

type mdnsSRV struct {
	priority uint16
	weight   uint16
	port     uint16
	target   string
}

// discoverMDNSService uses a real DNS-SD browse for the supplied service type.
// It follows RFC 6762/6763 by sending PTR questions to the link-local mDNS
// multicast address and resolving PTR -> SRV/TXT -> A/AAAA records.
func discoverMDNSService(ctx context.Context, service string) ([]DeviceInfo, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	queryCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()

	ifaces, err := mdnsInterfaces()
	if err != nil {
		return nil, err
	}
	if len(ifaces) == 0 {
		return nil, fmt.Errorf("no multicast-capable IPv4 interfaces")
	}

	type result struct {
		entries []*mdnsServiceEntry
	}
	results := make(chan result, len(ifaces))
	for _, iface := range ifaces {
		go func(iface *net.Interface) {
			entries, err := browseMDNSOnInterface(queryCtx, iface, service)
			if err != nil {
				log.Printf("[discovery] mDNS %s on %s: %v", service, iface.Name, err)
				results <- result{}
				return
			}
			results <- result{entries: entries}
		}(iface)
	}

	merged := make(map[string]*mdnsServiceEntry)
	for i := 0; i < len(ifaces); i++ {
		select {
		case r := <-results:
			for _, entry := range r.entries {
				key := strings.ToLower(entry.instance + "|" + entry.service)
				if existing, ok := merged[key]; ok {
					mergeMDNSServiceEntry(existing, entry)
				} else {
					merged[key] = entry
				}
			}
		case <-queryCtx.Done():
			goto DONE
		}
	}

DONE:
	out := make([]DeviceInfo, 0, len(merged))
	for _, entry := range merged {
		if entry.srv == nil || entry.srv.target == "" || entry.srv.port == 0 {
			continue
		}
		var ip net.IP
		if len(entry.ips) > 0 {
			ip = entry.ips[0]
		}
		if ip == nil {
			resolvedCtx, resolvedCancel := context.WithTimeout(ctx, 600*time.Millisecond)
			ip = resolveMDNSHost(resolvedCtx, entry.srv.target)
			resolvedCancel()
		}
		if ip == nil {
			continue
		}

		secure := entry.service == "_ipps._tcp" || strings.Contains(entry.service, "._ipps._tcp")
		scheme := "ipp"
		if secure {
			scheme = "ipps"
		}
		rp := entry.txt["rp"]
		if rp == "" {
			rp = "/ipp/print"
		}
		if !strings.HasPrefix(rp, "/") {
			rp = "/" + rp
		}
		endpoint := fmt.Sprintf("%s://%s:%d%s", scheme, ip.String(), entry.srv.port, rp)
		name := entry.instance
		if name == "" {
			name = entry.txt["ty"]
		}
		if name == "" {
			name = entry.txt["product"]
		}
		if name == "" {
			name = entry.srv.target
		}

		caps := map[string]interface{}{
			"discovered_via": "mdns_dns_sd",
			"mdns_verified":  true,
			"service_type":   entry.service,
			"service_name":   entry.instance,
			"hostname":       strings.TrimSuffix(entry.srv.target, "."),
			"rp":             rp,
			"port":           int(entry.srv.port),
		}
		for k, v := range entry.txt {
			caps["txt_"+k] = v
		}
		if v := entry.txt["ty"]; v != "" {
			caps["model"] = v
		}
		if v := entry.txt["product"]; v != "" {
			caps["product"] = v
		}
		if v := entry.txt["adminurl"]; v != "" {
			caps["admin_url"] = v
		}
		if v := entry.txt["UUID"]; v != "" {
			caps["uuid"] = v
		}

		id := StableIDFromNetwork(ip.String(), int(entry.srv.port))
		out = append(out, DeviceInfo{
			ID:             id,
			Name:           name,
			DisplayName:    name,
			PrinterType:    "unknown",
			ConnectionType: "ipp",
			Protocol:       scheme,
			Endpoint:       endpoint,
			NetworkAddress: ip.String(),
			Port:           int(entry.srv.port),
			Status:         "online",
			Enabled:        true,
			Type:           "ipp",
			Capabilities:   caps,
		})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

type mdnsServiceEntry struct {
	instance string
	service  string
	srv      *mdnsSRV
	txt      map[string]string
	ips      []net.IP
}

func mergeMDNSServiceEntry(dst, src *mdnsServiceEntry) {
	if dst.srv == nil && src.srv != nil {
		dst.srv = src.srv
	}
	if dst.txt == nil {
		dst.txt = make(map[string]string)
	}
	for k, v := range src.txt {
		if _, ok := dst.txt[k]; !ok || dst.txt[k] == "" {
			dst.txt[k] = v
		}
	}
	seen := make(map[string]bool)
	for _, ip := range dst.ips {
		seen[ip.String()] = true
	}
	for _, ip := range src.ips {
		if ip != nil && !seen[ip.String()] {
			dst.ips = append(dst.ips, ip)
		}
	}
}

func mdnsInterfaces() ([]*net.Interface, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	var out []*net.Interface
	for i := range ifaces {
		iface := &ifaces[i]
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if len(iface.HardwareAddr) == 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			if ipNet, ok := addr.(*net.IPNet); ok && ipNet.IP.To4() != nil {
				out = append(out, iface)
				break
			}
		}
	}
	return out, nil
}

func browseMDNSOnInterface(ctx context.Context, iface *net.Interface, service string) ([]*mdnsServiceEntry, error) {
	conn, err := net.ListenMulticastUDP("udp4", iface, &net.UDPAddr{IP: net.ParseIP(mdnsIPv4), Port: mdnsPort})
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		return nil, err
	}
	if err := conn.SetWriteDeadline(time.Now().Add(500 * time.Millisecond)); err != nil {
		return nil, err
	}

	query, err := buildMDNSPTRQuery(service)
	if err != nil {
		return nil, err
	}
	if _, err := conn.WriteToUDP(query, &net.UDPAddr{IP: net.ParseIP(mdnsIPv4), Port: mdnsPort}); err != nil {
		return nil, err
	}

	instances := make(map[string]*mdnsServiceEntry)
	buf := make([]byte, 9000)
	for {
		select {
		case <-ctx.Done():
			return mapsToEntries(instances), nil
		default:
		}
		if err := conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond)); err != nil {
			return nil, err
		}
		n, _, err := conn.ReadFromUDP(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				if ctx.Err() != nil {
					return mapsToEntries(instances), nil
				}
				continue
			}
			return nil, err
		}
		for _, rr := range parseMDNSPacket(buf[:n]) {
			if rr.type_ != 12 {
				continue
			}
			instance := rr.ptr
			if instance == "" {
				continue
			}
			entry := instances[strings.ToLower(instance)]
			if entry == nil {
				entry = &mdnsServiceEntry{instance: trimFQDN(instance), service: trimFQDN(service), txt: make(map[string]string)}
				instances[strings.ToLower(instance)] = entry
			}
		}
		// Parse all records again so additional SRV/TXT/A/AAAA records can be
		// associated with the discovered service instances.
		records := parseMDNSPacket(buf[:n])
		for _, rr := range records {
			if rr.type_ == 33 && rr.srv != nil {
				for _, entry := range instances {
					if strings.EqualFold(strings.TrimSuffix(entry.instance, ".")+"."+strings.TrimSuffix(entry.service, ".")+".local.", rr.name) || entry.srv == nil {
						if entry.srv == nil && strings.Contains(strings.ToLower(rr.name), strings.ToLower(entry.instance)+".") {
							entry.srv = rr.srv
						}
					}
				}
			}
			if rr.type_ == 16 && rr.txt != nil {
				for _, entry := range instances {
					if strings.HasPrefix(strings.ToLower(rr.name), strings.ToLower(entry.instance)+".") {
						for k, v := range rr.txt {
							entry.txt[k] = v
						}
					}
				}
			}
			if (rr.type_ == 1 || rr.type_ == 28) && rr.data != nil {
				for _, entry := range instances {
					if entry.srv != nil && strings.EqualFold(trimFQDN(entry.srv.target), trimFQDN(rr.name)) {
						for _, ip := range rr.ips {
							if ip != nil {
								entry.ips = append(entry.ips, ip)
							}
						}
					}
				}
			}
		}
	}
}

func mapsToEntries(m map[string]*mdnsServiceEntry) []*mdnsServiceEntry {
	out := make([]*mdnsServiceEntry, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	return out
}

func resolveMDNSHost(ctx context.Context, host string) net.IP {
	lookupHost := trimFQDN(host)
	if !strings.HasSuffix(strings.ToLower(lookupHost), ".local") {
		lookupHost += ".local"
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip4", lookupHost)
	if err == nil && len(ips) > 0 {
		return ips[0]
	}
	return nil
}

func trimFQDN(s string) string {
	return strings.TrimSuffix(strings.TrimSpace(s), ".")
}

func buildMDNSPTRQuery(service string) ([]byte, error) {
	service = strings.TrimSuffix(strings.TrimSpace(service), ".") + "."
	var packet []byte
	packet = append(packet, 0, 0) // id
	packet = append(packet, 0, 0) // flags
	packet = append(packet, 0, 1) // qdcount
	packet = append(packet, 0, 0) // an
	packet = append(packet, 0, 0) // ns
	packet = append(packet, 0, 0) // ar
	packet = append(packet, encodeDNSName(service)...)
	packet = append(packet, 0, 12) // PTR
	packet = append(packet, 0x00, 0x01) // IN
	return packet, nil
}

func encodeDNSName(name string) []byte {
	name = strings.TrimSuffix(name, ".")
	var out []byte
	for _, label := range strings.Split(name, ".") {
		if label == "" {
			continue
		}
		if len(label) > 63 {
			label = label[:63]
		}
		out = append(out, byte(len(label)))
		out = append(out, []byte(label)...)
	}
	out = append(out, 0)
	return out
}

func parseMDNSPacket(data []byte) []mdnsRecord {
	if len(data) < 12 {
		return nil
	}
	qd := int(binary.BigEndian.Uint16(data[4:6]))
	an := int(binary.BigEndian.Uint16(data[6:8]))
	ns := int(binary.BigEndian.Uint16(data[8:10]))
	ar := int(binary.BigEndian.Uint16(data[10:12]))
	pos := 12
	for i := 0; i < qd; i++ {
		_, next, ok := decodeDNSName(data, pos)
		if !ok || next+4 > len(data) {
			return nil
		}
		pos = next + 4
	}
	total := an + ns + ar
	out := make([]mdnsRecord, 0, total)
	for i := 0; i < total; i++ {
		name, next, ok := decodeDNSName(data, pos)
		if !ok || next+10 > len(data) {
			return out
		}
		type_ := binary.BigEndian.Uint16(data[next : next+2])
		class := binary.BigEndian.Uint16(data[next+2 : next+4])
		rdlen := int(binary.BigEndian.Uint16(data[next+8 : next+10]))
		rstart := next + 10
		rend := rstart + rdlen
		if rend > len(data) {
			return out
		}
		rr := mdnsRecord{name: trimFQDN(name), type_: type_, data: append([]byte(nil), data[rstart:rend]...)}
		if class&0x7fff != 1 {
			pos = rend
			continue
		}
		switch type_ {
		case 12:
			if target, _, ok := decodeDNSName(data, rstart); ok {
				rr.ptr = trimFQDN(target)
			}
		case 16:
			rr.txt = parseDNSTXT(data[rstart:rend])
		case 33:
			if rdlen >= 6 {
				priority := binary.BigEndian.Uint16(data[rstart : rstart+2])
				weight := binary.BigEndian.Uint16(data[rstart+2 : rstart+4])
				port := binary.BigEndian.Uint16(data[rstart+4 : rstart+6])
				target, _, ok := decodeDNSName(data, rstart+6)
				if ok {
					rr.srv = &mdnsSRV{priority: priority, weight: weight, port: port, target: trimFQDN(target)}
				}
			}
		case 1:
			if rdlen == net.IPv4len {
				rr.ips = []net.IP{net.IPv4(data[rstart], data[rstart+1], data[rstart+2], data[rstart+3])}
			}
		case 28:
			if rdlen == net.IPv6len {
				rr.ips = []net.IP{net.IP(append([]byte(nil), data[rstart:rend]...))}
			}
		}
		out = append(out, rr)
		pos = rend
	}
	return out
}

func decodeDNSName(data []byte, start int) (string, int, bool) {
	if start < 0 || start >= len(data) {
		return "", start, false
	}
	var labels []string
	pos := start
	next := -1
	seen := make(map[int]bool)
	for hops := 0; hops < 32; hops++ {
		if pos >= len(data) || seen[pos] {
			return "", start, false
		}
		seen[pos] = true
		length := int(data[pos])
		if length == 0 {
			pos++
			if next < 0 {
				next = pos
			}
			return strings.Join(labels, ".") + ".", next, true
		}
		if length&0xc0 == 0xc0 {
			if pos+1 >= len(data) {
				return "", start, false
			}
			offset := ((length & 0x3f) << 8) | int(data[pos+1])
			if offset >= len(data) {
				return "", start, false
			}
			if next < 0 {
				next = pos + 2
			}
			pos = offset
			continue
		}
		if length > 63 || pos+1+length > len(data) {
			return "", start, false
		}
		labels = append(labels, string(data[pos+1:pos+1+length]))
		pos += 1 + length
	}
	return "", start, false
}

func parseDNSTXT(data []byte) map[string]string {
	out := make(map[string]string)
	for pos := 0; pos < len(data); {
		length := int(data[pos])
		pos++
		if length > len(data)-pos {
			break
		}
		text := string(data[pos : pos+length])
		pos += length
		if idx := strings.IndexByte(text, '='); idx >= 0 {
			key := text[:idx]
			out[key] = text[idx+1:]
		} else if text != "" {
			out[text] = ""
		}
	}
	return out
}
