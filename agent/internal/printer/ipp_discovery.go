package printer

import (
	"context"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

// discoverIPPPrinters performs IPP/IPPS discovery via TCP 631 scan and mDNS.
// It is additive and bounded. Currently TCP 631 scan is primary; mDNS is best-effort.
func discoverIPPPrinters(ctx context.Context) ([]DeviceInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	// First, try mDNS for _ipp._tcp.local and _ipps._tcp.local
	mdnsFound := discoverMDNSPrinters(ctx)

	// Then TCP 631 scan of local private subnets (similar to 9100)
	tcpFound, err := discoverIPPviaTCP(ctx)
	if err != nil {
		log.Printf("[discovery] IPP TCP scan error: %v", err)
	}

	// Merge mDNS and TCP results with dedup by host:port
	seen := make(map[string]bool)
	var out []DeviceInfo
	for _, di := range append(mdnsFound, tcpFound...) {
		key := fmt.Sprintf("%s:%d", strings.ToLower(di.NetworkAddress), di.Port)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, di)
	}
	if len(out) > 0 {
		log.Printf("[discovery] IPP discovery found %d printers (mDNS %d, TCP %d)", len(out), len(mdnsFound), len(tcpFound))
	} else {
		log.Printf("[discovery] IPP discovery: no printers found (mDNS %d, TCP %d)", len(mdnsFound), len(tcpFound))
	}
	return out, nil
}

func discoverIPPviaTCP(ctx context.Context) ([]DeviceInfo, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	var targets []string
	seenSubnet := make(map[string]bool)
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		// Skip virtual adapters
		ifNameLower := strings.ToLower(iface.Name)
		if strings.HasPrefix(ifNameLower, "veth") ||
			strings.HasPrefix(ifNameLower, "docker") ||
			strings.HasPrefix(ifNameLower, "br-") ||
			strings.HasPrefix(ifNameLower, "tailscale") ||
			strings.HasPrefix(ifNameLower, "tap") ||
			strings.HasPrefix(ifNameLower, "tun") {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsMulticast() {
				continue
			}
			if !ip.IsPrivate() {
				continue
			}
			mask := ipNet.Mask
			if len(mask) == 16 {
				mask = mask[12:]
			}
			if len(mask) == 4 {
				ones, bits := ipNet.Mask.Size()
				if bits == 32 && ones < 24 {
					mask = net.CIDRMask(24, 32)
					ipNet = &net.IPNet{IP: ip.Mask(mask), Mask: mask}
				}
			}
			subnetKey := ipNet.String()
			if seenSubnet[subnetKey] {
				continue
			}
			seenSubnet[subnetKey] = true
			hosts := generateHosts(ipNet)
			if len(hosts) > 254 {
				hosts = hosts[:254]
			}
			for _, h := range hosts {
				if h.Equal(ip) {
					continue
				}
				targets = append(targets, net.JoinHostPort(h.String(), "631"))
			}
			log.Printf("[discovery] IPP scanning subnet %s (%s) %d hosts", subnetKey, iface.Name, len(hosts))
		}
	}
	if len(targets) == 0 {
		return nil, nil
	}
	const workers = 32
	const perHostTimeout = 500 * time.Millisecond
	jobs := make(chan string, len(targets))
	results := make(chan DeviceInfo, len(targets))
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for target := range jobs {
				select {
				case <-ctx.Done():
					return
				default:
				}
				host, portStr, _ := net.SplitHostPort(target)
				d := net.Dialer{Timeout: perHostTimeout}
				connCtx, cancel := context.WithTimeout(ctx, perHostTimeout)
				conn, err := d.DialContext(connCtx, "tcp", target)
				cancel()
				if err != nil {
					// Most hosts on a /24 refuse the connection: skipping
					// the target must not kill this worker (a plain return
					// here silently drained the worker pool after ~32
					// refusals and truncated the scan).
					continue
				}
				conn.Close()
				port := 631
				fmt.Sscanf(portStr, "%d", &port)
				// Try to verify it's really IPP by doing Get-Printer-Attributes
				// If it fails, still treat as potential IPP printer but mark status
				urlStr := fmt.Sprintf("http://%s:%d/ipp/print", host, port)
				// Quick probe: try to fetch via IPP
				ippProbe := IPPPrinter{URL: urlStr, Name: host}
				status := "online"
				probeCtx, cancel2 := context.WithTimeout(ctx, 2*time.Second)
				if _, err := ippProbe.getPrinterAttributes(probeCtx); err != nil {
					// If IPP not responding, still keep as IPP candidate but status unknown
					// Check if HTTP GET to / succeeds
					status = "unknown"
				}
				cancel2()
				id := StableIDFromNetwork(host, port)
				// Use ipp:// URL as endpoint for later printing
				ippURL := fmt.Sprintf("ipp://%s/ipp/print", target)
				name := fmt.Sprintf("IPP Printer %s", host)

				// Bounded rDNS reverse lookup (500ms)
				rDnsCtx, rDnsCancel := context.WithTimeout(ctx, 500*time.Millisecond)
				var resolver net.Resolver
				if names, err := resolver.LookupAddr(rDnsCtx, host); err == nil && len(names) > 0 {
					n := strings.TrimSuffix(names[0], ".")
					if n != "" {
						name = fmt.Sprintf("IPP Printer %s (%s)", host, n)
					}
				}
				rDnsCancel()

				di := DeviceInfo{
					ID:             id,
					Name:           name,
					DisplayName:    name,
					PrinterType:    "unknown",
					ConnectionType: "ipp",
					Protocol:       "ipp",
					Endpoint:       ippURL,
					NetworkAddress: host,
					Port:           port,
					Status:         status,
					Enabled:        true,
					Type:           "ipp",
					Capabilities:   map[string]interface{}{"discovered_via": "ipp_tcp_scan", "ipp_url": ippURL},
				}
				select {
				case results <- di:
					log.Printf("[discovery] found IPP printer: %s:631 -> %s", host, id)
				case <-ctx.Done():
					return
				}
			}
		}()
	}
targetLoop:
	for _, t := range targets {
		select {
		case jobs <- t:
		case <-ctx.Done():
			break targetLoop
		}
	}
	close(jobs)
	// Channel-ownership law (see discoverSNMPPrinters in
	// discovery_extended.go): close(results) only after EVERY worker has
	// finished its send. Workers are bounded: dial/rDNS/IPP-probe contexts
	// all derive from this ctx, so each returns within ~1s of expiry and
	// buffered sends never block.
	wg.Wait()
	close(results)
	var out []DeviceInfo
	seenID := make(map[string]bool)
	for di := range results {
		if !seenID[di.ID] {
			seenID[di.ID] = true
			out = append(out, di)
		}
	}
	return out, nil
}

// discoverMDNSPrinters performs mDNS query for _ipp._tcp, _ipps._tcp, and _printer._tcp.
func discoverMDNSPrinters(ctx context.Context) []DeviceInfo {
	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		log.Printf("[discovery] zeroconf resolver init error: %v", err)
		return nil
	}

	browseCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()

	services := []string{"_ipp._tcp", "_ipps._tcp", "_printer._tcp"}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var out []DeviceInfo
	seen := make(map[string]bool)

	for _, svc := range services {
		wg.Add(1)
		go func(s string) {
			defer wg.Done()
			ch := make(chan *zeroconf.ServiceEntry, 32)
			doneCh := make(chan struct{})
			go func() {
				defer close(doneCh)
				for entry := range ch {
					di, ok := parseMDNSServiceEntry(entry)
					if !ok {
						continue
					}
					key := fmt.Sprintf("%s:%d", strings.ToLower(di.NetworkAddress), di.Port)
					mu.Lock()
					if !seen[key] {
						seen[key] = true
						out = append(out, di)
					}
					mu.Unlock()
				}
			}()

			_ = resolver.Browse(browseCtx, s, "local.", ch)
			<-doneCh
		}(svc)
	}

	wg.Wait()
	return out
}

func parseMDNSServiceEntry(entry *zeroconf.ServiceEntry) (DeviceInfo, bool) {
	if entry == nil || len(entry.AddrIPv4) == 0 || entry.AddrIPv4[0] == nil {
		return DeviceInfo{}, false
	}
	ip := entry.AddrIPv4[0].String()
	port := entry.Port
	if port <= 0 {
		port = 631
	}

	txtMeta := parseMDNSTXT(entry.Text)

	name := txtMeta.ty
	if name == "" {
		name = txtMeta.product
	}
	if name == "" && txtMeta.model != "" {
		name = txtMeta.model
	}
	if name == "" {
		name = entry.Instance
	}
	if name == "" {
		name = fmt.Sprintf("mDNS Printer %s", ip)
	}

	rp := txtMeta.rp
	if rp == "" {
		rp = "ipp/print"
	}
	rpClean := strings.TrimPrefix(rp, "/")

	protocol := "ipp"
	endpointScheme := "ipp"
	if strings.Contains(entry.Service, "_ipps") {
		protocol = "ipps"
		endpointScheme = "ipps"
	}

	endpoint := fmt.Sprintf("%s://%s:%d/%s", endpointScheme, ip, port, rpClean)

	caps := map[string]interface{}{
		"mdns_verified":  true,
		"discovered_via": "mdns",
		"pdl":            txtMeta.pdlList,
	}
	if txtMeta.mfg != "" {
		caps["manufacturer"] = txtMeta.mfg
	}
	if txtMeta.model != "" {
		caps["model"] = txtMeta.model
	}
	if txtMeta.ty != "" {
		caps["ty"] = txtMeta.ty
	}
	if txtMeta.rp != "" {
		caps["rp"] = txtMeta.rp
	}

	di := DeviceInfo{
		ID:             StableIDFromNetwork(ip, port),
		Name:           name,
		DisplayName:    name,
		PrinterType:    "unknown",
		ConnectionType: "ipp",
		Protocol:       protocol,
		Endpoint:       endpoint,
		NetworkAddress: ip,
		Port:           port,
		Status:         "online",
		Enabled:        true,
		Type:           "ipp",
		Capabilities:   caps,
	}
	return di, true
}

type mdnsTXTMetadata struct {
	ty      string
	product string
	rp      string
	pdlList []string
	mfg     string
	model   string
}

func parseMDNSTXT(text []string) mdnsTXTMetadata {
	var meta mdnsTXTMetadata
	for _, t := range text {
		parts := strings.SplitN(t, "=", 2)
		k := strings.ToLower(strings.TrimSpace(parts[0]))
		v := ""
		if len(parts) == 2 {
			v = strings.TrimSpace(parts[1])
		}
		switch k {
		case "ty":
			meta.ty = v
		case "product":
			meta.product = strings.Trim(v, "()")
		case "rp":
			meta.rp = v
		case "pdl":
			if v != "" {
				for _, p := range strings.Split(v, ",") {
					p = strings.TrimSpace(p)
					if p != "" {
						meta.pdlList = append(meta.pdlList, p)
					}
				}
			}
		case "usb_mfg":
			meta.mfg = v
		case "usb_mdl":
			meta.model = v
		}
	}
	return meta
}
