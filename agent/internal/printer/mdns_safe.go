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
	services := []string{
		"_ipp._tcp.local.",
		"_ipps._tcp.local.",
		"_print._sub._ipp._tcp.local.",
		"_print._sub._ipps._tcp.local.",
	}
	if ctx == nil {
		ctx = context.Background()
	}

	ctx, cancel := context.WithTimeout(ctx, 4500*time.Millisecond)
	defer cancel()

	ifaces, err := mdnsInterfaces()
	if err != nil {
		return nil, err
	}
	if len(ifaces) == 0 {
		return nil, fmt.Errorf("no multicast-capable IPv4 interfaces")
	}

	type answer struct {
	devices []DeviceInfo
	err     error
	}
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
	go func() {
		wg.Wait()
		close(answers)
	}()

	seen := make(map[string]bool)
	var out []DeviceInfo
	var errs []string
	for a := range answers {
		if a.err != nil {
			errs = append(errs, a.err.Error())
		}
		for _, d := range a.devices {
			key := strings.ToLower(fmt.Sprintf("%s:%d", d.NetworkAddress, d.Port))
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, d)
		}
	}
	if len(errs) > 0 && len(out) == 0 {
		return out, fmt.Errorf("mDNS discovery: %s", strings.Join(errs, "; "))
	}
	return out, nil
}

func browseMDNSServicesExact(ctx context.Context, iface *net.Interface, services []string) ([]DeviceInfo, error) {
	conn, err := net.ListenMulticastUDP("udp4", iface, &net.UDPAddr{IP: net.ParseIP(mdnsIPv4), Port: mdnsPort})
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	serviceQueries := make([][]byte, 0, len(services))
	for _, service := range services {
		query, err := buildMDNSPTRQuery(service)
		if err != nil {
			return nil, err
		}
		serviceQueries = append(serviceQueries, query)
	}
	for _, query := range serviceQueries {
		_ = conn.SetWriteDeadline(time.Now().Add(500 * time.Millisecond))
		if _, err := conn.WriteToUDP(query, &net.UDPAddr{IP: net.ParseIP(mdnsIPv4), Port: mdnsPort}); err != nil {
			log.Printf("[discovery] mDNS query write on %s failed: %v", iface.Name, err)
		}
	}

	type rawRecords struct{ records []mdnsRecord }
	var records []mdnsRecord
	buf := make([]byte, 9000)
	for {
		if ctx.Err() != nil {
			break
		}
		deadline := time.Now().Add(150 * time.Millisecond)
		if err := conn.SetReadDeadline(deadline); err != nil {
			return nil, err
		}
		n, _, err := conn.ReadFromUDP(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			return nil, err
		}
		parsed := parseMDNSPacket(buf[:n])
		if len(parsed) > 0 {
			records = append(records, parsed...)
		}
	}

	serviceSet := make(map[string]bool)
	for _, s := range services {
		serviceSet[strings.ToLower(trimFQDN(s))] = true
	}
	instances := make(map[string]struct {
		service string
		srv     *mdnsSRV
		txt     map[string]string
		ips     []net.IP
	})

	for _, rr := range records {
		if rr.type_ != 12 || rr.ptr == "" || !serviceSet[strings.ToLower(trimFQDN(rr.name))] {
			continue
		}
		key := strings.ToLower(trimFQDN(rr.ptr))
		e := instances[key]
		if e.txt == nil {
			e.txt = make(map[string]string)
		}
		e.service = strings.ToLower(trimFQDN(rr.name))
		instances[key] = e
	}

	// Use exact owner names for SRV/TXT. No prefix/substring matching.
	for _, rr := range records {
		key := strings.ToLower(trimFQDN(rr.name))
		e, ok := instances[key]
		if !ok {
			continue
		}
		switch rr.type_ {
		case 33:
			if rr.srv != nil {
				e.srv = rr.srv
			}
		case 16:
			for k, v := range rr.txt {
				e.txt[k] = v
			}
		}
		instances[key] = e
	}

	// Resolve target addresses by exact owner name. PTR responses normally carry
	// these in the additional section; we also resolve missing targets with the
	// system resolver using .local, which is supported by Windows mDNS stacks.
	for key, e := range instances {
		if e.srv == nil || e.srv.target == "" || e.srv.port == 0 {
			continue
		}
		target := strings.ToLower(trimFQDN(e.srv.target))
		for _, rr := range records {
			if strings.ToLower(trimFQDN(rr.name)) != target {
				continue
			}
			if rr.type_ == 1 || rr.type_ == 28 {
				e.ips = appendUniqueIPs(e.ips, rr.ips...)
			}
		}
		if len(e.ips) == 0 {
			resolveCtx, resolveCancel := context.WithTimeout(ctx, 500*time.Millisecond)
			ip := resolveMDNSHost(resolveCtx, e.srv.target)
			resolveCancel()
			if ip != nil {
				e.ips = append(e.ips, ip)
			}
		}
		instances[key] = e
	}

	out := make([]DeviceInfo, 0, len(instances))
	for _, e := range instances {
		if e.srv == nil || len(e.ips) == 0 {
			continue
		}
		ip := e.ips[0]
		secure := strings.EqualFold(e.service, "_ipps._tcp.local") || strings.Contains(e.service, "._ipps._tcp.local")
		scheme := "ipp"
		if secure {
			scheme = "ipps"
		}
		rp := strings.TrimSpace(e.txt["rp"])
		if rp == "" {
			rp = "/ipp/print"
		}
		if !strings.HasPrefix(rp, "/") {
			rp = "/" + rp
		}
		host := ip.String()
		endpoint := fmt.Sprintf("%s://%s:%d%s", scheme, host, e.srv.port, rp)
		name := strings.TrimSuffix(key, ".")
		if parts := strings.SplitN(name, ".", 2); len(parts) > 0 && parts[0] != "" {
			name = parts[0]
		}
		if e.txt["ty"] != "" {
			name = e.txt["ty"]
		}
		if e.txt["product"] != "" && e.txt["ty"] == "" {
			name = e.txt["product"]
		}

		caps := map[string]interface{}{
			"discovered_via": "mdns_dns_sd",
			"mdns_verified":  true,
			"service_type":   e.service,
			"service_name":   key,
			"hostname":       strings.TrimSuffix(e.srv.target, "."),
			"rp":             rp,
			"port":            int(e.srv.port),
		}
		for k, v := range e.txt {
			caps["txt_"+k] = v
		}
		for _, attr := range []struct{ src, dst string }{
			{"ty", "model"}, {"product", "product"}, {"adminurl", "admin_url"}, {"UUID", "uuid"},
		} {
			if v := e.txt[attr.src]; v != "" {
				caps[attr.dst] = v
			}
		}

		out = append(out, DeviceInfo{
			ID:             StableIDFromNetwork(host, int(e.srv.port)),
			Name:           name,
			DisplayName:    name,
			PrinterType:    "unknown",
			ConnectionType: "ipp",
			Protocol:       scheme,
			Endpoint:       endpoint,
			NetworkAddress: host,
			Port:           int(e.srv.port),
			Status:         "online",
			Enabled:        true,
			Type:           "ipp",
			Capabilities:   caps,
		})
	}
	_ = ctx
	return out, nil
}

func appendUniqueIPs(dst []net.IP, ips ...net.IP) []net.IP {
	seen := make(map[string]bool)
	for _, ip := range dst {
		seen[ip.String()] = true
	}
	for _, ip := range ips {
		if ip != nil && !seen[ip.String()] {
			dst = append(dst, ip)
			seen[ip.String()] = true
		}
	}
	return dst
}
