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

// discoverIPPPrinters performs standards-based IPP/IPPS discovery.
// Primary discovery is DNS-SD/mDNS (_ipp._tcp, _ipps._tcp and the
// IPP Everywhere subtypes). TCP/631 probing is a fallback only and a host is
// returned from that path only when an actual IPP Get-Printer-Attributes
// request succeeds. This prevents an arbitrary service listening on 631 from
// being presented as a printer.
func discoverIPPPrinters(ctx context.Context) ([]DeviceInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	mdnsFound, mdnsErr := discoverMDNSPrinters(ctx)
	if mdnsErr != nil {
		log.Printf("[discovery] IPP mDNS discovery warning: %v", mdnsErr)
	}

	tcpFound, tcpErr := discoverIPPviaTCP(ctx)
	if tcpErr != nil {
		log.Printf("[discovery] IPP TCP discovery warning: %v", tcpErr)
	}

	seen := make(map[string]bool)
	out := make([]DeviceInfo, 0, len(mdnsFound)+len(tcpFound))
	for _, di := range append(mdnsFound, tcpFound...) {
		key := strings.ToLower(fmt.Sprintf("%s:%d", di.NetworkAddress, di.Port))
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, di)
	}
	if len(out) > 0 {
		log.Printf("[discovery] IPP discovery found %d printers (mDNS %d, TCP verified %d)", len(out), len(mdnsFound), len(tcpFound))
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
			if ip == nil || ip.IsLoopback() || ip.IsMulticast() || !ip.IsPrivate() {
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
		}
	}
	if len(targets) == 0 {
		return nil, nil
	}

	const workers = 32
	const perHostTimeout = 700 * time.Millisecond
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
				port := 631
				if _, err := fmt.Sscanf(portStr, "%d", &port); err != nil {
					continue
				}

				// TCP reachability is only a cheap pre-check. The actual proof of
				// printer identity is a valid IPP Get-Printer-Attributes response.
				d := net.Dialer{Timeout: perHostTimeout}
				probeCtx, cancel := context.WithTimeout(ctx, perHostTimeout)
				conn, err := d.DialContext(probeCtx, "tcp", target)
				cancel()
				if err != nil {
					continue
				}
				_ = conn.Close()

				probeTimeout := 2 * time.Second
				if deadline, ok := ctx.Deadline(); ok {
					remaining := time.Until(deadline)
					if remaining > 0 && remaining < probeTimeout {
						probeTimeout = remaining
					}
				}
				probeCtx, cancel = context.WithTimeout(ctx, probeTimeout)
				var verifiedURL string
				var attrs map[string]string
				for _, candidate := range []string{
					fmt.Sprintf("http://%s:%d/ipp/print", host, port),
					fmt.Sprintf("http://%s:%d/ipp/printer", host, port),
					fmt.Sprintf("http://%s:%d/printers/ipp", host, port),
					fmt.Sprintf("http://%s:%d/ipp", host, port),
					fmt.Sprintf("https://%s:%d/ipp/print", host, port),
					fmt.Sprintf("https://%s:%d/ipp/printer", host, port),
				} {
					probe := IPPPrinter{URL: candidate, Name: host}
					var probeAttrs map[string]string
					probeAttrs, err = probe.getPrinterAttributes(probeCtx)
					if err == nil && probeAttrs != nil && (probeAttrs["printer-uri-supported"] != "" || probeAttrs["printer-state"] != "" || probeAttrs["printer-make-and-model"] != "") {
						verifiedURL = candidate
						attrs = probeAttrs
						break
					}
					if probeCtx.Err() != nil {
						break
					}
				}
				cancel()
				if verifiedURL == "" {
					continue
				}

				name := attrs["printer-info"]
				if name == "" {
					name = attrs["printer-make-and-model"]
				}
				if name == "" {
					name = attrs["printer-name"]
				}
				if name == "" {
					name = fmt.Sprintf("IPP Printer %s", host)
				}
				caps := map[string]interface{}{
					"discovered_via": "ipp_tcp_verified",
					"ipp_verified":   true,
					"ipp_url":        verifiedURL,
				}
				for _, key := range []string{
					"printer-uri-supported", "document-format-supported", "printer-make-and-model", "printer-info", "printer-name", "printer-state", "printer-state-reasons", "printer-is-accepting-jobs", "ipp-versions-supported", "operations-supported",
				} {
					if v := attrs[key]; v != "" {
						caps[key] = v
					}
				}
				hostName := host
				if names, lookupErr := net.LookupAddr(host); lookupErr == nil && len(names) > 0 {
					hostName = strings.TrimSuffix(names[0], ".")
				}
				caps["hostname"] = hostName

				id := StableIDFromNetwork(host, port)
				di := DeviceInfo{
					ID:             id,
					Name:           name,
					DisplayName:    name,
					PrinterType:    "unknown",
					ConnectionType: "ipp",
					Protocol:       strings.SplitN(strings.ToLower(verifiedURL), ":", 2)[0],
					Endpoint:       verifiedURL,
					NetworkAddress: host,
					Port:           port,
					Status:         "online",
					Enabled:        true,
					Type:           "ipp",
					Capabilities:   caps,
				}
				select {
				case results <- di:
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

	out := make([]DeviceInfo, 0)
	seenID := make(map[string]bool)
	for di := range results {
		if seenID[di.ID] {
			continue
		}
		seenID[di.ID] = true
		out = append(out, di)
	}
	return out, nil
}

func discoverMDNSPrinters(ctx context.Context) ([]DeviceInfo, error) {
	services := []string{
		"_ipp._tcp.local.",
		"_ipps._tcp.local.",
		"_print._sub._ipp._tcp.local.",
		"_print._sub._ipps._tcp.local.",
	}
	var out []DeviceInfo
	seen := make(map[string]bool)
	var errs []string
	for _, service := range services {
		entries, err := discoverMDNSService(ctx, service)
		if err != nil {
			errs = append(errs, service+": "+err.Error())
			continue
		}
		for _, di := range entries {
			key := strings.ToLower(fmt.Sprintf("%s:%d", di.NetworkAddress, di.Port))
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, di)
		}
	}
	if len(errs) > 0 {
		return out, fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return out, nil
}
