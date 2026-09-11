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

// discoverNetworkPrinters performs active LAN discovery for RAW TCP printers
// (port 9100). It is additive to spooler enumeration and respects safety:
// - only scans private IPv4 subnets derived from local interfaces
// - bounded concurrency (32), per-host 500ms, global 8s timeout
// - context cancellation
// - deduplication via stable ID
// Returns DeviceInfos with ConnectionType network, Protocol raw, Status online.
func discoverNetworkPrinters(ctx context.Context) ([]DeviceInfo, error) {
	// Global timeout for network discovery
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("net.Interfaces: %w", err)
	}

	var targets []string
	seenSubnet := make(map[string]bool)

	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		// Skip virtual adapters that pollute local scanning
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
			// Only private ranges (and not link-local 169.254)
			if !ip.IsPrivate() {
				continue
			}
			// Derive /24 subnet around this IP to avoid scanning huge /8 or /16.
			// Normalize IPv4-mapped 16-byte masks (common from Go on
			// dual-stack Windows) to 4-byte form FIRST: generateHosts
			// re-reads ipNet.Mask and returns empty for 16-byte masks.
			mask := ipNet.Mask
			if len(mask) == 16 {
				mask = mask[12:]
			}
			ipNet = &net.IPNet{IP: ip, Mask: mask}
			if len(mask) == 4 {
				// If mask is /16 or /8, clamp to /24 around local IP
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

			// Generate hosts for this subnet (limit to 254 hosts max)
			hosts := generateHosts(ipNet)
			if len(hosts) > 254 {
				hosts = hosts[:254]
			}
			// Avoid scanning our own IP and gateway .0/.255
			for _, h := range hosts {
				if h.Equal(ip) {
					continue
				}
				targets = append(targets, net.JoinHostPort(h.String(), "9100"))
			}
			log.Printf("[discovery] scanning subnet %s (%s) %d hosts", subnetKey, iface.Name, len(hosts))
		}
	}

	// 1. Concurrently launch WSD multicast probe
	var wsdDevices []DeviceInfo
	var wsdWg sync.WaitGroup
	wsdWg.Add(1)
	go func() {
		defer wsdWg.Done()
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[discovery] WSD discovery panic: %v", r)
			}
		}()
		devs, err := discoverWSDPrinters(ctx)
		if err != nil {
			log.Printf("[discovery] WSD discovery error: %v", err)
		} else {
			wsdDevices = devs
		}
	}()

	var tcpDevices []DeviceInfo
	if len(targets) == 0 {
		log.Printf("[discovery] network discovery: no private subnets found, skipping TCP scan")
	} else {
		// Bounded concurrent TCP probes
		const tcpWorkers = 32
		const perHostTimeout = 500 * time.Millisecond

		jobs := make(chan string, len(targets))
		openHosts := make(chan DeviceInfo, len(targets))
		results := make(chan DeviceInfo, len(targets))

		var tcpWg sync.WaitGroup
		for w := 0; w < tcpWorkers; w++ {
			tcpWg.Add(1)
			go func() {
				defer tcpWg.Done()
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
						continue
					}
					conn.Close()

					port := 9100
					if portStr != "" {
						fmt.Sscanf(portStr, "%d", &port)
					}
					id := StableIDFromNetwork(host, port)
					name := fmt.Sprintf("Network Printer %s", host)

					// Bounded rDNS reverse lookup (500ms)
					rDnsCtx, rDnsCancel := context.WithTimeout(ctx, 500*time.Millisecond)
					var resolver net.Resolver
					if names, err := resolver.LookupAddr(rDnsCtx, host); err == nil && len(names) > 0 {
						n := strings.TrimSuffix(names[0], ".")
						if n != "" {
							name = fmt.Sprintf("Network Printer %s (%s)", host, n)
						}
					}
					rDnsCancel()

					di := DeviceInfo{
						ID:             id,
						Name:           name,
						DisplayName:    name,
						PrinterType:    "unknown",
						ConnectionType: "network",
						Protocol:       "raw",
						Endpoint:       target,
						NetworkAddress: host,
						Port:           port,
						Status:         "online",
						Enabled:        true,
						Type:           "network",
						Capabilities: map[string]interface{}{
							"discovered_via": "tcp_raw_scan",
							"port":           port,
							"verification":   "candidate",
							"confidence":     "low",
						},
					}
					select {
					case openHosts <- di:
						log.Printf("[discovery] found TCP printer: %s (9100) -> %s", host, id)
					case <-ctx.Done():
						return
					}
				}
			}()
		}

		// SNMP worker pool (max 16 concurrent workers) to enrich candidate metadata
		const snmpWorkers = 16
		var snmpWg sync.WaitGroup
		for sw := 0; sw < snmpWorkers; sw++ {
			snmpWg.Add(1)
			go func() {
				defer snmpWg.Done()
				for di := range openHosts {
					select {
					case <-ctx.Done():
						return
					default:
					}

					snmpDev, ok := probeSNMPPrinter(ctx, di.NetworkAddress)
					if ok {
						if di.Capabilities == nil {
							di.Capabilities = make(map[string]interface{})
						}
						di.Capabilities["snmp_verified"] = true
						di.Capabilities["discovered_via"] = "snmp"
						di.Capabilities["verification"] = "verified"
						di.Capabilities["confidence"] = "high"
						if snmpDev.Capabilities != nil {
							if descr, ok := snmpDev.Capabilities["sysDescr"]; ok {
								di.Capabilities["sysDescr"] = descr
							}
							if ser, ok := snmpDev.Capabilities["serial"]; ok && ser != "" {
								di.Capabilities["serial"] = ser
							}
							if mfg, ok := snmpDev.Capabilities["manufacturer"]; ok && mfg != "" {
								di.Capabilities["manufacturer"] = mfg
							}
						}
						if snmpDev.Name != "" && isGenericPrinterName(di.Name) {
							di.Name = snmpDev.Name
							di.DisplayName = snmpDev.DisplayName
						}
						if snmpDev.Protocol != "" && snmpDev.Protocol != "raw" {
							di.Protocol = snmpDev.Protocol
						}
						di.Status = "online"
					}
					select {
					case results <- di:
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

		go func() {
			tcpWg.Wait()
			close(openHosts)
		}()

		go func() {
			snmpWg.Wait()
			close(results)
		}()

		for di := range results {
			tcpDevices = append(tcpDevices, di)
		}
	}

	// Wait for WSD probe completion
	wsdWg.Wait()

	// Merge all devices using dedupeKey and StableIDForDevice
	allFound := append(tcpDevices, wsdDevices...)
	out := mergeNetworkDevices(allFound)

	log.Printf("[discovery] network discovery completed: %d printers found (TCP+SNMP: %d, WSD: %d)",
		len(out), len(tcpDevices), len(wsdDevices))
	return out, nil
}

func isGenericPrinterName(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	if lower == "" {
		return true
	}
	if strings.HasPrefix(lower, "network printer") ||
		strings.HasPrefix(lower, "wsd printer") ||
		strings.HasPrefix(lower, "snmp printer") ||
		strings.HasPrefix(lower, "ipp printer") {
		return true
	}
	return false
}

func mergeNetworkDevices(devices []DeviceInfo) []DeviceInfo {
	merged := make(map[string]*DeviceInfo)
	var order []string

	for _, d := range devices {
		key := dedupeKey(d)
		if key == "" {
			if d.NetworkAddress != "" && d.Port > 0 {
				key = fmt.Sprintf("ip:%s:%d", strings.ToLower(d.NetworkAddress), d.Port)
			} else {
				key = d.ID
			}
		}
		if key == "" {
			key = StableIDForDevice(d)
		}

		// Also check by IP:Port to ensure TCP 9100 and WSD (with UUID) merge on same host
		ipPortKey := ""
		if d.NetworkAddress != "" && d.Port > 0 {
			ipPortKey = fmt.Sprintf("ip:%s:%d", strings.ToLower(d.NetworkAddress), d.Port)
		}

		existing, ok := merged[key]
		if !ok && ipPortKey != "" {
			existing, ok = merged[ipPortKey]
		}

		if !ok {
			dCopy := d
			if dCopy.Capabilities == nil {
				dCopy.Capabilities = make(map[string]interface{})
			}
			if dCopy.ID == "" {
				dCopy.ID = StableIDForDevice(dCopy)
			}
			merged[key] = &dCopy
			if ipPortKey != "" && ipPortKey != key {
				merged[ipPortKey] = &dCopy
			}
			order = append(order, key)
			continue
		}

		// Merge attributes
		if existing.Capabilities == nil {
			existing.Capabilities = make(map[string]interface{})
		}

		for k, v := range d.Capabilities {
			if _, exists := existing.Capabilities[k]; !exists || v == true {
				existing.Capabilities[k] = v
			}
		}

		snmpV := isCapabilityVerified(existing.Capabilities, "snmp_verified") || isCapabilityVerified(d.Capabilities, "snmp_verified")
		wsdV := isCapabilityVerified(existing.Capabilities, "wsd_verified") || isCapabilityVerified(d.Capabilities, "wsd_verified")
		mdnsV := isCapabilityVerified(existing.Capabilities, "mdns_verified") || isCapabilityVerified(d.Capabilities, "mdns_verified")

		if snmpV || wsdV || mdnsV {
			existing.Capabilities["verification"] = "verified"
			existing.Capabilities["confidence"] = "high"
		}

		if isGenericPrinterName(existing.Name) && !isGenericPrinterName(d.Name) {
			existing.Name = d.Name
			existing.DisplayName = d.DisplayName
		}

		if mfg, ok := d.Capabilities["manufacturer"]; ok && fmt.Sprint(mfg) != "" {
			existing.Capabilities["manufacturer"] = mfg
		}
		if model, ok := d.Capabilities["model"]; ok && fmt.Sprint(model) != "" {
			existing.Capabilities["model"] = model
		}

		if (existing.Protocol == "" || existing.Protocol == "raw") && d.Protocol != "" && d.Protocol != "raw" {
			existing.Protocol = d.Protocol
		}

		if d.Status == "online" {
			existing.Status = "online"
		}

		existing.ID = StableIDForDevice(*existing)
	}

	seen := make(map[string]bool)
	var out []DeviceInfo
	for _, k := range order {
		dev := merged[k]
		if dev != nil && !seen[dev.ID] {
			seen[dev.ID] = true
			out = append(out, *dev)
		}
	}
	return out
}

func isCapabilityVerified(caps map[string]interface{}, key string) bool {
	if caps == nil {
		return false
	}
	v, ok := caps[key]
	if !ok {
		return false
	}
	b, ok := v.(bool)
	return ok && b
}

func generateHosts(ipNet *net.IPNet) []net.IP {
	var hosts []net.IP
	ip := ipNet.IP.To4()
	mask := ipNet.Mask
	if ip == nil {
		return hosts
	}
	network := ip.Mask(mask)
	// For /24, iterate 1..254
	// For other masks, iterate all hosts but cap
	ones, bits := mask.Size()
	if bits != 32 {
		return hosts
	}
	total := 1 << (32 - ones)
	if total > 1024 {
		total = 1024 // safety cap
	}
	base := ipToUint32(network)
	for i := 1; i < total-1 && len(hosts) < 254; i++ {
		h := uint32ToIP(base + uint32(i))
		if h != nil {
			hosts = append(hosts, h)
		}
	}
	return hosts
}

func ipToUint32(ip net.IP) uint32 {
	ip = ip.To4()
	if ip == nil {
		return 0
	}
	return uint32(ip[0])<<24 | uint32(ip[1])<<16 | uint32(ip[2])<<8 | uint32(ip[3])
}
func uint32ToIP(n uint32) net.IP {
	return net.IPv4(byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
}
