package printer

import (
	"context"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

// discoverMDNSPrintersSafe performs exact DNS-SD association:
// service PTR -> instance -> SRV/TXT -> target A/AAAA. It deliberately does
// not use fuzzy owner-name matching, so multiple printers advertised on the
// same LAN cannot have their endpoints or capabilities mixed together.
func discoverMDNSPrintersSafe(ctx context.Context) ([]DeviceInfo, error) {
	services := []string{"_ipp._tcp.local.", "_ipps._tcp.local.", "_print._sub._ipp._tcp.local.", "_print._sub._ipps._tcp.local."}
	if ctx == nil { ctx = context.Background() }
	ctx, cancel := context.WithTimeout(ctx, 4500*time.Millisecond)
	defer cancel()
	ifaces, err := mdnsInterfaces()
	if err != nil { return nil, err }
	if len(ifaces) == 0 { return nil, fmt.Errorf("no multicast-capable IPv4 interfaces") }

	type answer struct { devices []DeviceInfo; err error }
	answers := make(chan answer, len(ifaces))
	var wg sync.WaitGroup
	for _, iface := range ifaces {
		iface := iface
		wg.Add(1)
		go func() {
			defer wg.Done()
			devices, err := browseMDNSServicesExact(ctx, iface, services)
			answers <- answer{devices: devices, err: err}
		}()
	}
	go func(){ wg.Wait(); close(answers) }()

	seen := make(map[string]bool)
	var out []DeviceInfo
	var errs []string
	for a := range answers {
		if a.err != nil { errs = append(errs, a.err.Error()) }
		for _, d := range a.devices {
			key := strings.ToLower(fmt.Sprintf("%s:%d", d.NetworkAddress, d.Port))
			if seen[key] { continue }
			seen[key] = true
			out = append(out, d)
		}
	}
	if len(errs) > 0 && len(out) == 0 { return out, fmt.Errorf("mDNS discovery: %s", strings.Join(errs, "; ")) }
	return out, nil
}

func browseMDNSServicesExact(ctx context.Context, iface *net.Interface, services []string) ([]DeviceInfo, error) {
	conn, err := net.ListenMulticastUDP("udp4", iface, &net.UDPAddr{IP: net.ParseIP(mdnsIPv4), Port: mdnsPort})
	if err != nil { return nil, err }
	defer conn.Close()

	for _, service := range services {
		query, err := buildMDNSPTRQuery(service)
		if err != nil { return nil, err }
		_ = conn.SetWriteDeadline(time.Now().Add(500*time.Millisecond))
		if _, err := conn.WriteToUDP(query, &net.UDPAddr{IP: net.ParseIP(mdnsIPv4), Port: mdnsPort}); err != nil {
			log.Printf("[discovery] mDNS query write on %s failed: %v", iface.Name, err)
		}
	}

	var records []mdnsRecord
	buf := make([]byte, 9000)
	for {
		if ctx.Err() != nil { break }
		if err := conn.SetReadDeadline(time.Now().Add(150*time.Millisecond)); err != nil { return nil, err }
		n, _, err := conn.ReadFromUDP(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() { continue }
			return nil, err
		}
		if parsed := parseMDNSPacket(buf[:n]); len(parsed) > 0 { records = append(records, parsed...) }
	}

	serviceSet := make(map[string]bool)
	for _, service := range services { serviceSet[strings.ToLower(trimFQDN(service))] = true }
	type mdnsEntry struct { service string; srv *mdnsSRV; txt map[string]string; ips []net.IP }
	instances := make(map[string]*mdnsEntry)
	for _, rr := range records {
		if rr.type_ != 12 || rr.ptr == "" || !serviceSet[strings.ToLower(trimFQDN(rr.name))] { continue }
		key := strings.ToLower(trimFQDN(rr.ptr))
		entry := instances[key]
		if entry == nil { entry = &mdnsEntry{txt: make(map[string]string)}; instances[key] = entry }
		entry.service = strings.ToLower(trimFQDN(rr.name))
	}

	// Exact owner matching: SRV/TXT owner is the DNS-SD service instance name.
	for _, rr := range records {
		entry := instances[strings.ToLower(trimFQDN(rr.name))]
		if entry == nil { continue }
		switch rr.type_ {
		case 33:
			if rr.srv != nil { entry.srv = rr.srv }
		case 16:
			for k, v := range rr.txt { entry.txt[k] = v }
		}
	}
	for _, entry := range instances {
		if entry.srv == nil || entry.srv.target == "" || entry.srv.port == 0 { continue }
		target := strings.ToLower(trimFQDN(entry.srv.target))
		for _, rr := range records {
			if strings.ToLower(trimFQDN(rr.name)) == target && (rr.type_ == 1 || rr.type_ == 28) { entry.ips = appendUniqueIPs(entry.ips, rr.ips...) }
		}
		if len(entry.ips) == 0 {
			resolveCtx, resolveCancel := context.WithTimeout(ctx, 500*time.Millisecond)
			if ip := resolveMDNSHost(resolveCtx, entry.srv.target); ip != nil { entry.ips = append(entry.ips, ip) }
			resolveCancel()
		}
	}

	out := make([]DeviceInfo, 0, len(instances))
	for instance, entry := range instances {
		if entry.srv == nil || len(entry.ips) == 0 { continue }
		ip := entry.ips[0]
		secure := strings.HasPrefix(entry.service, "_ipps._tcp") || strings.Contains(entry.service, "._ipps._tcp")
		scheme := "ipp"
		if secure { scheme = "ipps" }
		rp := strings.TrimSpace(entry.txt["rp"])
		if rp == "" { rp = "/ipp/print" }
		if !strings.HasPrefix(rp, "/") { rp = "/" + rp }
		host := strings.TrimSuffix(entry.srv.target, ".")
		if host == "" { host = ip.String() }
		endpoint := fmt.Sprintf("%s://%s:%d%s", scheme, host, entry.srv.port, rp)
		name := strings.SplitN(instance, ".", 2)[0]
		if v := strings.TrimSpace(entry.txt["ty"]); v != "" { name = v } else if v := strings.TrimSpace(entry.txt["product"]); v != "" { name = v }
		caps := map[string]interface{}{"discovered_via":"mdns_dns_sd", "mdns_verified":true, "service_type":entry.service, "service_name":instance, "hostname":host, "rp":rp, "port":int(entry.srv.port)}
		for k, v := range entry.txt { caps["txt_"+k] = v }
		for _, a := range []struct{src,dst string}{{"ty","model"},{"product","product"},{"adminurl","admin_url"},{"UUID","uuid"}} { if v := entry.txt[a.src]; v != "" { caps[a.dst] = v } }
		out = append(out, DeviceInfo{ID:StableIDFromNetwork(ip.String(), int(entry.srv.port)), Name:name, DisplayName:name, PrinterType:"unknown", ConnectionType:"ipp", Protocol:scheme, Endpoint:endpoint, NetworkAddress:ip.String(), Port:int(entry.srv.port), Status:"online", Enabled:true, Type:"ipp", Capabilities:caps})
	}
	return out, nil
}

func appendUniqueIPs(dst []net.IP, ips ...net.IP) []net.IP {
	seen := make(map[string]bool)
	for _, ip := range dst { seen[ip.String()] = true }
	for _, ip := range ips { if ip != nil && !seen[ip.String()] { dst = append(dst, ip); seen[ip.String()] = true } }
	return dst
}
