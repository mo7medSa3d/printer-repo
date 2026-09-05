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

// discoverIPPPrinters uses standards-based DNS-SD/mDNS first and a verified
// IPP TCP/631 fallback. An open port or an mDNS advertisement alone is never
// exposed as a verified IPP printer.
func discoverIPPPrinters(ctx context.Context) ([]DeviceInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	mdnsFound, mdnsErr := discoverMDNSPrintersSafe(ctx)
	if mdnsErr != nil {
		log.Printf("[discovery] IPP mDNS discovery warning: %v", mdnsErr)
	}

	// mDNS proves service advertisement, but it does not prove that the IPP
	// endpoint is currently reachable and speaking IPP. Verify each advertised
	// endpoint before surfacing it as an IPP printer.
	verifiedMDNS := make([]DeviceInfo, 0, len(mdnsFound))
	for _, d := range mdnsFound {
		if ctx.Err() != nil {
			break
		}
		if d.Endpoint == "" {
			continue
		}
		printer, err := NewIPPPrinter(d.Endpoint, d.Name)
		if err != nil {
			log.Printf("[discovery] rejecting malformed mDNS IPP endpoint %q: %v", d.Endpoint, err)
			continue
		}
		verifyCtx, verifyCancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		attrs, err := printer.getPrinterAttributes(verifyCtx)
		verifyCancel()
		if err != nil || !isVerifiedIPPAttributes(attrs) {
			if err != nil {
				log.Printf("[discovery] mDNS IPP verification failed for %s: %v", d.Endpoint, err)
			}
			continue
		}
		if d.Capabilities == nil {
			d.Capabilities = make(map[string]interface{})
		}
		d.Capabilities["ipp_verified"] = true
		d.Capabilities["ipp_url"] = printer.URL
		for _, key := range []string{"printer-state", "printer-state-reasons", "printer-is-accepting-jobs", "printer-uri-supported", "document-format-supported", "printer-make-and-model", "printer-info", "printer-name", "ipp-versions-supported"} {
			if v := attrs[key]; v != "" {
				d.Capabilities[key] = v
			}
		}
		d.Endpoint = printer.URL
		d.ID = StableIDForDevice(d)
		verifiedMDNS = append(verifiedMDNS, d)
	}

	tcpFound, tcpErr := discoverIPPviaTCP(ctx)
	if tcpErr != nil {
		log.Printf("[discovery] IPP TCP discovery warning: %v", tcpErr)
	}

	seen := make(map[string]bool)
	out := make([]DeviceInfo, 0, len(verifiedMDNS)+len(tcpFound))
	for _, d := range append(verifiedMDNS, tcpFound...) {
		key := strings.ToLower(net.JoinHostPort(d.NetworkAddress, fmt.Sprintf("%d", d.Port)))
		if key == ":0" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, d)
	}
	if mdnsErr != nil && tcpErr != nil && len(out) == 0 {
		return nil, fmt.Errorf("IPP discovery failed: mDNS: %v; TCP verification: %v", mdnsErr, tcpErr)
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
			if ip == nil || !ip.IsPrivate() {
				continue
			}
			mask := ipNet.Mask
			if ones, bits := mask.Size(); bits == 32 && ones < 24 {
				mask = net.CIDRMask(24, 32)
				ipNet = &net.IPNet{IP: ip.Mask(mask), Mask: mask}
			}
			subnet := ipNet.String()
			if seenSubnet[subnet] {
				continue
			}
			seenSubnet[subnet] = true
			for _, host := range generateHosts(ipNet) {
				if host.Equal(ip) {
					continue
				}
				targets = append(targets, net.JoinHostPort(host.String(), "631"))
			}
		}
	}
	if len(targets) == 0 {
		return nil, nil
	}

	const workers = 32
	const probeTimeout = 2 * time.Second
	jobs := make(chan string, len(targets))
	results := make(chan DeviceInfo, len(targets))
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
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
				probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
				verifiedURL, attrs := verifyIPPPrinter(probeCtx, host, port)
				cancel()
				if verifiedURL == "" || !isVerifiedIPPAttributes(attrs) {
					continue
				}
				name := firstIPPString(attrs, "printer-info", "printer-make-and-model", "printer-name")
				if name == "" {
					name = "IPP Printer " + host
				}
				caps := map[string]interface{}{"discovered_via": "ipp_tcp_verified", "ipp_verified": true, "ipp_url": verifiedURL}
				for _, key := range []string{"printer-state", "printer-state-reasons", "printer-is-accepting-jobs", "printer-uri-supported", "document-format-supported", "printer-make-and-model", "printer-info", "printer-name", "ipp-versions-supported"} {
					if v := attrs[key]; v != "" {
						caps[key] = v
					}
				}
				select {
				case results <- DeviceInfo{ID: StableIDFromNetwork(host, port), Name: name, DisplayName: name, PrinterType: "unknown", ConnectionType: "ipp", Protocol: "ipp", Endpoint: verifiedURL, NetworkAddress: host, Port: port, Status: "online", Enabled: true, Type: "ipp", Capabilities: caps}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	for _, target := range targets {
		select {
		case jobs <- target:
		case <-ctx.Done():
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
	for d := range results {
		if seenID[d.ID] {
			continue
		}
		seenID[d.ID] = true
		out = append(out, d)
	}
	return out, nil
}

func verifyIPPPrinter(ctx context.Context, host string, port int) (string, map[string]string) {
	for _, endpoint := range []string{
		fmt.Sprintf("http://%s:%d/ipp/print", host, port),
		fmt.Sprintf("http://%s:%d/ipp/printer", host, port),
		fmt.Sprintf("http://%s:%d/ipp", host, port),
		fmt.Sprintf("https://%s:%d/ipp/print", host, port),
		fmt.Sprintf("https://%s:%d/ipp/printer", host, port),
	} {
		attrs, err := (&IPPPrinter{URL: endpoint, Name: host}).getPrinterAttributes(ctx)
		if err == nil && isVerifiedIPPAttributes(attrs) {
			return endpoint, attrs
		}
		if ctx.Err() != nil {
			break
		}
	}
	return "", nil
}

func isVerifiedIPPAttributes(attrs map[string]string) bool {
	if attrs == nil {
		return false
	}
	return attrs["printer-uri-supported"] != "" || attrs["printer-state"] != "" || attrs["printer-make-and-model"] != "" || attrs["printer-name"] != ""
}

func firstIPPString(attrs map[string]string, keys ...string) string {
	for _, key := range keys {
		if v := strings.TrimSpace(attrs[key]); v != "" {
			return v
		}
	}
	return ""
}
