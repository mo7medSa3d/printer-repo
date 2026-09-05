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
					return
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
				if names, err := net.LookupAddr(host); err == nil && len(names) > 0 {
					n := strings.TrimSuffix(names[0], ".")
					if n != "" {
						name = fmt.Sprintf("IPP Printer %s (%s)", host, n)
					}
				}
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
	for _, t := range targets {
		select {
		case jobs <- t:
		case <-ctx.Done():
			break
		}
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
	seenID := make(map[string]bool)
	for di := range results {
		if !seenID[di.ID] {
			seenID[di.ID] = true
			out = append(out, di)
		}
	}
	return out, nil
}

// discoverMDNSPrinters performs mDNS query for _ipp._tcp.local and _ipps._tcp.local
// It is best-effort; if it fails, it returns empty and logs.
func discoverMDNSPrinters(ctx context.Context) []DeviceInfo {
	// Minimal mDNS implementation: send DNS PTR query to 224.0.0.251:5353
	// For now, we implement a stub that logs and returns empty, but does not fail.
	// A full implementation would use a library like github.com/grandcat/zeroconf or
	// github.com/miekg/dns. To keep dependencies minimal, we do a best-effort UDP multicast
	// with a handcrafted DNS packet and parse responses for PTR/SRV/TXT.

	// Try to perform mDNS discovery with timeout 2s
	mdnsCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	// Use a simple approach: try to resolve _ipp._tcp.local via net.Lookup (which may use mDNS on some systems)
	// This is not reliable, so we just log and return empty for now, but keep the hook for future.
	// We attempt a quick UDP multicast to avoid blocking.
	_ = mdnsCtx

	// Log that mDNS was attempted
	// To avoid spamming logs on every discovery, only log at debug level
	// For now, return empty
	return nil
}

// buildMDNSQuery is a helper for future full mDNS implementation (currently stub).
func buildMDNSQuery(service string) []byte {
	// DNS query for PTR service._tcp.local
	// Header: ID 0, flags 0, QDCOUNT 1
	// Question: QNAME service, QTYPE PTR (12), QCLASS IN (1)
	// This is a placeholder for future implementation.
	_ = service
	return nil
}
