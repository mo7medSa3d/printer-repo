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
// A reachable 9100 port is only a discovery candidate; it is not proof that
// the endpoint is a printer or that RAW printing is supported.
func discoverNetworkPrinters(ctx context.Context) ([]DeviceInfo, error) {
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
				targets = append(targets, net.JoinHostPort(h.String(), "9100"))
			}
			log.Printf("[discovery] scanning subnet %s (%s) %d hosts", subnetKey, iface.Name, len(hosts))
		}
	}

	if len(targets) == 0 {
		log.Printf("[discovery] network discovery: no private subnets found, skipping TCP scan")
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
				host, portStr, err := net.SplitHostPort(target)
				if err != nil {
					continue
				}
				d := net.Dialer{Timeout: perHostTimeout}
				connCtx, cancel := context.WithTimeout(ctx, perHostTimeout)
				conn, err := d.DialContext(connCtx, "tcp", target)
				cancel()
				if err != nil {
					continue
				}
				_ = conn.Close()
				port := 9100
				if portStr != "" {
					fmt.Sscanf(portStr, "%d", &port)
				}
				id := StableIDFromNetwork(host, port)
				name := fmt.Sprintf("Network Printer %s", host)
				if names, err := net.LookupAddr(host); err == nil && len(names) > 0 {
					n := strings.TrimSuffix(names[0], ".")
					if n != "" {
						name = fmt.Sprintf("Network Printer %s (%s)", host, n)
					}
				}
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
					Status:         "unknown",
					Enabled:        true,
					Type:           "network",
					Capabilities: map[string]interface{}{
						"discovered_via": "tcp_raw_scan",
						"verification":   "candidate",
						"confidence":     "low",
						"port":           port,
					},
				}
				select {
				case results <- di:
					log.Printf("[discovery] found TCP candidate: %s (9100) -> %s", host, id)
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
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-ctx.Done():
		log.Printf("[discovery] network scan cancelled/timeout after %v", 8*time.Second)
	}

	close(results)

	var out []DeviceInfo
	seenID := make(map[string]bool)
	for di := range results {
		if !seenID[di.ID] {
			seenID[di.ID] = true
			out = append(out, di)
		} else {
			log.Printf("[discovery] duplicate TCP candidate merged: %s", di.ID)
		}
	}

	log.Printf("[discovery] network TCP discovery completed: %d candidates found", len(out))
	return out, nil
}

func generateHosts(ipNet *net.IPNet) []net.IP {
	var hosts []net.IP
	ip := ipNet.IP.To4()
	mask := ipNet.Mask
	if ip == nil {
		return hosts
	}
	network := ip.Mask(mask)
	ones, bits := mask.Size()
	if bits != 32 {
		return hosts
	}
	total := 1 << (32 - ones)
	if total > 1024 {
		total = 1024
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
