package printer

import (
	"context"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/odoo-print-agent/agent/internal/config"
)

func isValidDiscoveredPrinter(d DeviceInfo) bool {
	// Virtual printers are always valid where they are expected
	if d.IsVirtual {
		return true
	}
	nameLower := strings.ToLower(d.Name + " " + d.DisplayName)
	// Generic PnP / system devices must never be surfaced as printers
	genericSubstrings := []string{
		"usb input device",
		"usb composite device",
		"hid-compliant",
		"hid compliant",
		"standard system devices",
		"standard usb host controller",
		"intel(r) wireless bluetooth",
		"wireless bluetooth",
		"bluetooth adapter",
		"fingerprint sensor",
		"touch fingerprint",
		"synaptics",
		"vfs7552",
		"hd camera",
		"hp hd camera",
		"camera",
		"usb hub",
		"generic usb hub",
	}
	for _, g := range genericSubstrings {
		if strings.Contains(nameLower, g) {
			// If driver or name explicitly says printer, keep it (check "printer" not "print" to avoid fingerprint false positive)
			capsLower := ""
			if d.Capabilities != nil {
				if v, ok := d.Capabilities["driver_name"]; ok {
					capsLower += strings.ToLower(fmt.Sprint(v)) + " "
				}
				if v, ok := d.Capabilities["port_name"]; ok {
					capsLower += strings.ToLower(fmt.Sprint(v)) + " "
				}
			}
			combined := nameLower + " " + capsLower + strings.ToLower(d.PrinterType)
			if strings.Contains(combined, "printer") || strings.Contains(combined, "laser") || strings.Contains(combined, "inkjet") || strings.Contains(combined, "thermal") || strings.Contains(combined, "label") || strings.Contains(combined, "zebra") {
				continue
			}
			return false
		}
	}
	// For spooler-discovered devices, apply strict spooler validation if we have port/driver caps
	if d.ConnectionType == "spooler" || d.Protocol == "spooler" {
		portName := ""
		driverName := ""
		if d.Capabilities != nil {
			if v, ok := d.Capabilities["port_name"]; ok {
				portName = fmt.Sprint(v)
			}
			if v, ok := d.Capabilities["driver_name"]; ok {
				driverName = fmt.Sprint(v)
			}
		}
		// If we have port/driver, validate; if not, rely on name check above
		if portName != "" || driverName != "" {
			if !isValidSpoolerPrinter(portName, driverName, d.Name) {
				return false
			}
		}
	}
	// For USB, require printer evidence if we have hardware_ids in caps
	if d.ConnectionType == "usb" {
		if d.Capabilities != nil {
			var hwIDs, compatIDs []string
			if v, ok := d.Capabilities["hardware_ids"]; ok {
				switch vv := v.(type) {
				case []string:
					hwIDs = vv
				case []interface{}:
					for _, x := range vv {
						hwIDs = append(hwIDs, fmt.Sprint(x))
					}
				}
			}
			if v, ok := d.Capabilities["compatible_ids"]; ok {
				switch vv := v.(type) {
				case []string:
					compatIDs = vv
				case []interface{}:
					for _, x := range vv {
						compatIDs = append(compatIDs, fmt.Sprint(x))
					}
				}
			}
			classVal := ""
			if v, ok := d.Capabilities["class"]; ok {
				classVal = fmt.Sprint(v)
			}
			// If we have hardware IDs, enforce printer check; if no IDs (e.g., manual USB), allow
			if len(hwIDs) > 0 || len(compatIDs) > 0 {
				if !isPrinterUSBDevice(hwIDs, compatIDs, classVal) {
					return false
				}
			}
		}
	}
	return true
}

// DiscoveryResult is the outcome of enumerating all sources.
type DiscoveryResult struct {
	Printers []DeviceInfo `json:"printers"`
	Errors   []string     `json:"errors,omitempty"`
}

// DiscoverQuick enumerates only fast local sources (config, spooler, registry)
// without network/USB active scanning. Used for synchronous agent startup
// to avoid blocking on 8s LAN scan.
func DiscoverQuick(cfg *config.Config, registryPath string) DiscoveryResult {
	var (
		mu     sync.Mutex
		all    []DeviceInfo
		errors []string
		wg     sync.WaitGroup
		seen   = make(map[string]bool)
	)
	add := func(infos []DeviceInfo) {
		mu.Lock()
		defer mu.Unlock()
		for _, d := range infos {
			if d.ID == "" {
				d.ID = StableIDForDevice(d)
			}
			if !isValidDiscoveredPrinter(d) {
				log.Printf("[discovery] filtered non-printer device: %q type=%q conn=%q", d.Name, d.PrinterType, d.ConnectionType)
				continue
			}
			// Only real printing hardware becomes a managed printer. Virtual,
			// software and redirected queues never reach the registry, the
			// heartbeat or the Gateway.
			if !IsProductionPrinter(d) {
				cls := ClassifyDeviceInfo(d)
				log.Printf("[discovery] hiding non-physical printer: %q class=%s reasons=%v", d.Name, cls.Class, cls.Reasons)
				continue
			}
			if seen[d.ID] {
				for i, existing := range all {
					if existing.ID == d.ID {
						all[i] = mergeDeviceInfo(existing, d)
						break
					}
				}
				continue
			}
			seen[d.ID] = true
			all = append(all, d)
		}
	}
	addErr := func(msg string) {
		mu.Lock()
		errors = append(errors, msg)
		mu.Unlock()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() { if r := recover(); r != nil { addErr(fmt.Sprintf("config discovery panic: %v", r)) } }()
		add(discoverFromConfig(cfg))
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() { if r := recover(); r != nil { addErr(fmt.Sprintf("spooler discovery panic: %v", r)) } }()
		infos, err := discoverSpoolerPrinters()
		if err != nil {
			addErr(fmt.Sprintf("spooler discovery: %v", err))
			return
		}
		add(infos)
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() { if r := recover(); r != nil { addErr(fmt.Sprintf("registry discovery panic: %v", r)) } }()
		infos, err := loadRegistryPrinters(registryPath)
		if err != nil {
			if !strings.Contains(err.Error(), "no such file") {
				addErr(fmt.Sprintf("registry load: %v", err))
			}
			return
		}
		add(infos)
	}()
	wg.Wait()
	for i := range all {
		if all[i].ID == "" {
			all[i].ID = StableIDForDevice(all[i])
		}
		if all[i].Status == "" {
			all[i].Status = "unknown"
		}
		if all[i].ConnectionType == "" {
			all[i].ConnectionType = strings.ToLower(all[i].Type)
			if all[i].ConnectionType == "" {
				all[i].ConnectionType = "network"
			}
		}
		if all[i].Protocol == "" {
			all[i].Protocol = "raw"
		}
		if all[i].Type == "" {
			all[i].Type = all[i].ConnectionType
		}
	}
	return DiscoveryResult{Printers: all, Errors: errors}
}

// Discover enumerates printers from all available sources without crashing
// if a single source fails. Sources:
//   - Config printers (YAML legacy)
//   - Spooler printers (Windows EnumPrintersW, stub on non-Windows)
//   - Registry (printers.json)
//   - Network (active TCP 9100 scan, bounded, additive)
//   - USB (SetupDi enumeration, Windows only)
// It deduplicates by stable ID and returns idempotent results.
func Discover(cfg *config.Config, registryPath string) DiscoveryResult {
	var (
		mu     sync.Mutex
		all    []DeviceInfo
		errors []string
		wg     sync.WaitGroup
		seen   = make(map[string]bool)
	)

	add := func(infos []DeviceInfo) {
		mu.Lock()
		defer mu.Unlock()
		for _, d := range infos {
			if d.ID == "" {
				d.ID = StableIDForDevice(d)
			}
			if !isValidDiscoveredPrinter(d) {
				log.Printf("[discovery] filtered non-printer device: %q type=%q conn=%q", d.Name, d.PrinterType, d.ConnectionType)
				continue
			}
			// Only real printing hardware becomes a managed printer. Virtual,
			// software and redirected queues never reach the registry, the
			// heartbeat or the Gateway.
			if !IsProductionPrinter(d) {
				cls := ClassifyDeviceInfo(d)
				log.Printf("[discovery] hiding non-physical printer: %q class=%s reasons=%v", d.Name, cls.Class, cls.Reasons)
				continue
			}
			// Deduplicate by stable ID
			if seen[d.ID] {
				for i, existing := range all {
					if existing.ID == d.ID {
						// Merge: prefer newer with more info, but keep ID stable
						all[i] = mergeDeviceInfo(existing, d)
						break
					}
				}
				continue
			}
			// Cross-source dedup: same physical printer via spooler + network (same IP:port)
			if d.NetworkAddress != "" && d.Port != 0 {
				duplicate := false
				for i, existing := range all {
					if existing.NetworkAddress != "" && existing.Port != 0 && strings.EqualFold(existing.NetworkAddress, d.NetworkAddress) && existing.Port == d.Port {
						log.Printf("[discovery] duplicate printer merged (network %s:%d matches %q): %s + %s", d.NetworkAddress, d.Port, existing.SpoolerName, existing.ID, d.ID)
						all[i] = mergeDeviceInfo(existing, d)
						seen[d.ID] = true
						duplicate = true
						break
					}
					if existing.Endpoint != "" && strings.Contains(existing.Endpoint, d.NetworkAddress) {
						all[i] = mergeDeviceInfo(existing, d)
						seen[d.ID] = true
						duplicate = true
						break
					}
				}
				if duplicate {
					continue
				}
			}
			// USB dedup: same VID/PID/serial
			if d.USBVID != "" || d.USBSerial != "" {
				duplicate := false
				for i, existing := range all {
					if d.USBVID != "" && existing.USBVID != "" && strings.EqualFold(existing.USBVID, d.USBVID) && strings.EqualFold(existing.USBPID, d.USBPID) {
						// If both have serial, require serial match
						if d.USBSerial != "" && existing.USBSerial != "" && !strings.EqualFold(existing.USBSerial, d.USBSerial) {
							continue
						}
						log.Printf("[discovery] duplicate USB printer merged %s:%s serial %q", d.USBVID, d.USBPID, d.USBSerial)
						all[i] = mergeDeviceInfo(existing, d)
						seen[d.ID] = true
						duplicate = true
						break
					}
				}
				if duplicate {
					continue
				}
			}
			seen[d.ID] = true
			all = append(all, d)
		}
	}
	addErr := func(msg string) {
		mu.Lock()
		errors = append(errors, msg)
		mu.Unlock()
	}

	// 1. Config-file printers (legacy YAML) — always available
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("config discovery panic: %v", r))
			}
		}()
		infos := discoverFromConfig(cfg)
		add(infos)
	}()

	// 2. Spooler printers (Windows or stub)
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("spooler discovery panic: %v", r))
			}
		}()
		infos, err := discoverSpoolerPrinters()
		if err != nil {
			addErr(fmt.Sprintf("spooler discovery: %v", err))
			return
		}
		add(infos)
	}()

	// 3. Registry file printers (previously discovered / manually registered)
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("registry discovery panic: %v", r))
			}
		}()
		infos, err := loadRegistryPrinters(registryPath)
		if err != nil {
			if !strings.Contains(err.Error(), "no such file") {
				addErr(fmt.Sprintf("registry load: %v", err))
			}
			return
		}
		add(infos)
	}()

	// 4. Network printers (active TCP 9100 scan) — additive, bounded, not replacing spooler
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("network discovery panic: %v", r))
			}
		}()
		log.Printf("[discovery] starting network discovery (TCP 9100 scan)")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		infos, err := discoverNetworkPrinters(ctx)
		if err != nil {
			addErr(fmt.Sprintf("network discovery: %v", err))
			return
		}
		if len(infos) > 0 {
			log.Printf("[discovery] network discovery found %d TCP printers", len(infos))
		}
		add(infos)
	}()

	// 5. USB printers (SetupDi enumeration) — additive, Windows only
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("usb discovery panic: %v", r))
			}
		}()
		log.Printf("[discovery] starting USB discovery")
		infos, err := discoverUSBPrinters()
		if err != nil {
			addErr(fmt.Sprintf("usb discovery: %v", err))
			return
		}
		if len(infos) > 0 {
			log.Printf("[discovery] USB discovery found %d devices", len(infos))
		} else {
			log.Printf("[discovery] USB discovery: no devices found (or not on Windows)")
		}
		add(infos)
	}()

	// 6. IPP printers (mDNS + TCP 631 scan) — additive
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() {
			if r := recover(); r != nil {
				addErr(fmt.Sprintf("ipp discovery panic: %v", r))
			}
		}()
		log.Printf("[discovery] starting IPP discovery")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		infos, err := discoverIPPPrinters(ctx)
		if err != nil {
			addErr(fmt.Sprintf("ipp discovery: %v", err))
			return
		}
		if len(infos) > 0 {
			log.Printf("[discovery] IPP discovery found %d printers", len(infos))
		} else {
			log.Printf("[discovery] IPP discovery: no printers found")
		}
		add(infos)
	}()

	// 7. LPR/LPD (515) — bounded, safe probe
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() { if r := recover(); r != nil { addErr(fmt.Sprintf("lpr discovery panic: %v", r)) } }()
		log.Printf("[discovery] starting LPR discovery")
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		// reuse network targets for 515
		var lprTargets []string
		if ifaces, err := net.Interfaces(); err == nil {
			for _, iface := range ifaces {
				if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
					continue
				}
				addrs, _ := iface.Addrs()
				for _, addr := range addrs {
					if ipNet, ok := addr.(*net.IPNet); ok {
						if ip := ipNet.IP.To4(); ip != nil && ip.IsPrivate() {
							hosts := generateHosts(ipNet)
							for _, h := range hosts {
								lprTargets = append(lprTargets, h.String())
							}
						}
					}
				}
			}
		}
		if len(lprTargets) > 254 {
			lprTargets = lprTargets[:254]
		}
		infos := discoverLPRPrinters(ctx, lprTargets)
		if len(infos) > 0 {
			log.Printf("[discovery] LPR found %d printers", len(infos))
		}
		add(infos)
	}()

	// 8. SNMP (161) — read-only, public community
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() { if r := recover(); r != nil { addErr(fmt.Sprintf("snmp discovery panic: %v", r)) } }()
		log.Printf("[discovery] starting SNMP discovery")
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		var snmpTargets []string
		if ifaces, err := net.Interfaces(); err == nil {
			for _, iface := range ifaces {
				if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
					continue
				}
				addrs, _ := iface.Addrs()
				for _, addr := range addrs {
					if ipNet, ok := addr.(*net.IPNet); ok {
						if ip := ipNet.IP.To4(); ip != nil && ip.IsPrivate() {
							hosts := generateHosts(ipNet)
							for _, h := range hosts {
								snmpTargets = append(snmpTargets, h.String())
							}
						}
					}
				}
			}
		}
		if len(snmpTargets) > 100 {
			snmpTargets = snmpTargets[:100]
		}
		infos := discoverSNMPPrinters(ctx, snmpTargets)
		if len(infos) > 0 {
			log.Printf("[discovery] SNMP found %d printers", len(infos))
		}
		add(infos)
	}()

	// 9. WSD (WS-Discovery multicast) — platform independent probe
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() { if r := recover(); r != nil { addErr(fmt.Sprintf("wsd discovery panic: %v", r)) } }()
		log.Printf("[discovery] starting WSD discovery")
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		infos := discoverWSDPrinters(ctx)
		add(infos)
	}()

	// 10. mDNS full (224.0.0.251) — supplements IPP mDNS stub
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() { if r := recover(); r != nil { addErr(fmt.Sprintf("mdns discovery panic: %v", r)) } }()
		log.Printf("[discovery] starting mDNS discovery")
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		infos := discoverFullMDNS(ctx)
		add(infos)
	}()

	wg.Wait()
	log.Printf("[discovery] discovery completed: %d printers (errors: %d)", len(all), len(errors))

	// Ensure every entry has a stable ID and default status
	for i := range all {
		if all[i].ID == "" {
			all[i].ID = StableIDForDevice(all[i])
		}
		if all[i].Status == "" {
			all[i].Status = "unknown"
		}
		if all[i].ConnectionType == "" {
			all[i].ConnectionType = strings.ToLower(all[i].Type)
			if all[i].ConnectionType == "" {
				all[i].ConnectionType = "network"
			}
		}
		if all[i].Protocol == "" {
			all[i].Protocol = "raw"
		}
		if all[i].Type == "" {
			all[i].Type = all[i].ConnectionType
		}
	}

	return DiscoveryResult{Printers: all, Errors: errors}
}

func discoverFromConfig(cfg *config.Config) []DeviceInfo {
	var out []DeviceInfo
	if cfg == nil {
		return out
	}
	for _, pc := range cfg.Printers {
		di := DeviceInfo{
			ID:             pc.ID,
			Name:           pc.Name,
			DisplayName:    pc.Name,
			PrinterType:    "unknown",
			ConnectionType: pc.NormalizedType(),
			Protocol:       pc.NormalizedProtocol(),
			Endpoint:       pc.Endpoint,
			SpoolerName:    pc.SpoolerName,
			Status:         "unknown",
			Enabled:        pc.IsEnabled(),
			Type:           pc.NormalizedType(),
			// Printers declared in config.yaml are explicit operator intent:
			// they stay visible even when no transport can be proven, because
			// the operator typed the endpoint by hand.
			Capabilities: map[string]interface{}{"registration_source": "config"},
		}
		if di.ConnectionType == "spooler" {
			if di.SpoolerName == "" {
				di.SpoolerName = pc.Endpoint
			}
			if di.SpoolerName == "" {
				di.SpoolerName = pc.SpoolerName
			}
		}
		if di.ConnectionType == "network" {
			if host, portStr, err := net.SplitHostPort(pc.Endpoint); err == nil {
				di.NetworkAddress = host
				if p, err := strconv.Atoi(portStr); err == nil {
					di.Port = p
				}
			}
		}
		if di.ID == "" {
			di.ID = StableIDForDevice(di)
		}
		// Probe status via factory if possible (non-blocking, but uses 2s dial)
		if printer, err := New(pc); err == nil {
			// Run status in goroutine with timeout to avoid blocking discovery
			statusCh := make(chan string, 1)
			go func() {
				defer func() {
					if r := recover(); r != nil {
						statusCh <- "error"
					}
				}()
				statusCh <- printer.Status()
			}()
			select {
			case s := <-statusCh:
				di.Status = s
			case <-time.After(2500 * time.Millisecond):
				di.Status = "offline"
			}
		} else {
			di.Status = "error"
		}
		out = append(out, di)
	}
	return out
}

func discoverSpoolerPrinters() ([]DeviceInfo, error) {
	infos, err := enumSpoolerImpl()
	if err != nil {
		return nil, err
	}
	for i := range infos {
		if infos[i].ID == "" && infos[i].SpoolerName != "" {
			infos[i].ID = StableIDFromSpooler(infos[i].SpoolerName)
		}
		if infos[i].ID == "" {
			infos[i].ID = StableIDForDevice(infos[i])
		}
		// Probe online/offline via spooler stub/windows fast
		sp := NewSpooler(infos[i].SpoolerName, infos[i].Name)
		// Avoid blocking too long: status is fast (OpenPrinter)
		statusCh := make(chan string, 1)
		go func(s *SpoolerPrinter) {
			defer func() {
				if r := recover(); r != nil {
					statusCh <- "error"
				}
			}()
			statusCh <- s.Status()
		}(sp)
		select {
		case s := <-statusCh:
			infos[i].Status = s
		case <-time.After(2 * time.Second):
			infos[i].Status = "offline"
		}
	}
	return infos, nil
}

// enumSpoolerImpl delegates to platform-specific implementation.
func enumSpoolerImpl() ([]DeviceInfo, error) {
	infos, err := enumSpoolerPrintersPlatform()
	if err != nil {
		return nil, err
	}
	return infos, nil
}

// ListPrinters returns the current registry + config view suitable for CLI "printers list".
func ListPrinters(cfg *config.Config, registryPath string) ([]DeviceInfo, error) {
	result := Discover(cfg, registryPath)
	if len(result.Errors) > 0 {
		for _, e := range result.Errors {
			log.Printf("discovery warning: %s", e)
		}
	}
	return result.Printers, nil
}

func mergeDeviceInfo(existing, incoming DeviceInfo) DeviceInfo {
	merged := existing
	if incoming.Name != "" && incoming.Name != existing.Name {
		if existing.SpoolerName == "" && incoming.SpoolerName != "" {
			merged.Name = incoming.Name
			merged.DisplayName = incoming.DisplayName
		}
	}
	if incoming.NetworkAddress != "" {
		merged.NetworkAddress = incoming.NetworkAddress
	}
	if incoming.Port != 0 {
		merged.Port = incoming.Port
	}
	if incoming.SpoolerName != "" && merged.SpoolerName == "" {
		merged.SpoolerName = incoming.SpoolerName
	}
	if incoming.USBVID != "" && merged.USBVID == "" {
		merged.USBVID = incoming.USBVID
	}
	if incoming.USBPID != "" && merged.USBPID == "" {
		merged.USBPID = incoming.USBPID
	}
	if incoming.USBSerial != "" && merged.USBSerial == "" {
		merged.USBSerial = incoming.USBSerial
	}
	// USB and spooler same physical printer: if USB serial matches spooler printer's location/port, merge
	if incoming.ConnectionType == "usb" && existing.ConnectionType == "spooler" && incoming.USBVID != "" && existing.USBVID == "" {
		merged.USBVID = incoming.USBVID
		merged.USBPID = incoming.USBPID
		merged.USBSerial = incoming.USBSerial
		if merged.Capabilities == nil {
			merged.Capabilities = make(map[string]interface{})
		}
		for k, v := range incoming.Capabilities {
			if _, exists := merged.Capabilities[k]; !exists {
				merged.Capabilities[k] = v
			}
		}
		return merged
	}
	if incoming.Status != "" && incoming.Status != "unknown" {
		merged.Status = incoming.Status
	}
	if incoming.PrinterType != "" && incoming.PrinterType != "unknown" && merged.PrinterType == "unknown" {
		merged.PrinterType = incoming.PrinterType
	}
	if incoming.ConnectionType != "" {
		if merged.ConnectionType == "network" && incoming.ConnectionType == "spooler" {
			merged.ConnectionType = "spooler"
			merged.Protocol = "spooler"
		}
	}
	if incoming.Capabilities != nil {
		if merged.Capabilities == nil {
			merged.Capabilities = make(map[string]interface{})
		}
		for k, v := range incoming.Capabilities {
			merged.Capabilities[k] = v
		}
	}
	if incoming.Endpoint != "" && merged.Endpoint == "" {
		merged.Endpoint = incoming.Endpoint
	}
	return merged
}

// TestPrinter executes a real test print against the given printer ID and returns
// success/failure with meaningful error. It resolves the printer via discovery.
func TestPrinter(cfg *config.Config, registryPath, printerID string) error {
	printers, err := ListPrinters(cfg, registryPath)
	if err != nil {
		return fmt.Errorf("list printers: %w", err)
	}
	var target *DeviceInfo
	for _, p := range printers {
		if p.ID == printerID || p.SpoolerName == printerID || p.Name == printerID {
			// copy to avoid referencing loop var
			cp := p
			target = &cp
			break
		}
	}
	if target == nil {
		return fmt.Errorf("printer %q not found (discovered %d printers)", printerID, len(printers))
	}
	pc := config.PrinterConfig{
		ID:          target.ID,
		Name:        target.Name,
		Type:        target.ConnectionType,
		Endpoint:    target.Endpoint,
		Protocol:    target.Protocol,
		SpoolerName: target.SpoolerName,
	}
	if target.ConnectionType == "spooler" && pc.SpoolerName == "" {
		pc.SpoolerName = target.SpoolerName
		if pc.Endpoint == "" {
			pc.Endpoint = target.SpoolerName
		}
	}
	printer, err := New(pc)
	if err != nil {
		return fmt.Errorf("printer %s backend not available: %w", printerID, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return printer.Test(ctx)
}
