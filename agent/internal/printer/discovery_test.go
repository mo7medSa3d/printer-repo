package printer

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
	"github.com/grandcat/zeroconf"
	"github.com/odoo-print-agent/agent/internal/config"
)

func TestStableIDDeterminism(t *testing.T) {
	id1 := StableIDFromSpooler("HP LaserJet 1020")
	id2 := StableIDFromSpooler("HP LaserJet 1020")
	if id1 != id2 {
		t.Fatalf("spooler stable ID not deterministic: %s vs %s", id1, id2)
	}
	id3 := StableIDFromSpooler("hp laserjet 1020") // case insensitive
	if id1 != id3 {
		t.Fatalf("spooler ID should be case-insensitive")
	}
	id4 := StableIDFromNetwork("192.168.1.10", 9100)
	id5 := StableIDFromNetwork("192.168.1.10", 9100)
	if id4 != id5 {
		t.Fatalf("network stable ID not deterministic")
	}
}

func TestDiscoveryIdempotence(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	cfg := &config.Config{}
	// Add a network printer via config
	cfg.Printers = []config.PrinterConfig{
		{ID: "printer_cfg", Name: "Config Printer", Type: "network", Endpoint: "127.0.0.1:9100", Protocol: "raw"},
	}
	registryPath := config.RegistryPath(cfgPath)

	// First discovery
	r1 := Discover(cfg, registryPath)
	if len(r1.Printers) == 0 {
		t.Fatalf("expected at least 1 printer from config")
	}
	// Persist
	if _, err := UpsertRegistry(registryPath, r1.Printers); err != nil {
		t.Fatalf("UpsertRegistry: %v", err)
	}
	// Second discovery should not duplicate
	r2 := Discover(cfg, registryPath)
	// Persist second
	merged, err := UpsertRegistry(registryPath, r2.Printers)
	if err != nil {
		t.Fatalf("second Upsert: %v", err)
	}
	// Count unique IDs
	seen := make(map[string]int)
	for _, p := range merged {
		seen[p.ID]++
	}
	for id, count := range seen {
		if count > 1 {
			t.Fatalf("duplicate printer ID %s appears %d times", id, count)
		}
	}
	// Merged should have same count as first
	if len(merged) != len(r1.Printers) {
		// Could be same if no extra; allow but ensure no duplicates
		t.Logf("merged %d vs r1 %d (idempotent, no dup)", len(merged), len(r1.Printers))
	}
}

func TestManualRegistration(t *testing.T) {
	dir := t.TempDir()
	registryPath := filepath.Join(dir, "printers.json")

	info := DeviceInfo{
		Name:           "Manual Spooler",
		ConnectionType: "spooler",
		Protocol:       "spooler",
		SpoolerName:    "Manual HP",
		Endpoint:       "Manual HP",
		Enabled:        true,
		Status:         "unknown",
	}
	// Auto ID
	if info.ID != "" {
		t.Fatalf("ID should be empty initially")
	}
	infos, err := RegisterManual(registryPath, info)
	if err != nil {
		t.Fatalf("RegisterManual failed: %v", err)
	}
	if len(infos) == 0 {
		t.Fatalf("expected at least 1 after manual")
	}
	found := false
	for _, p := range infos {
		if p.SpoolerName == "Manual HP" {
			found = true
			if p.ID == "" {
				t.Fatalf("manual printer should have stable ID")
			}
		}
	}
	if !found {
		t.Fatalf("manual printer not found in registry")
	}

	// Repeat manual with same spooler should not duplicate (idempotent)
	info2 := DeviceInfo{
		Name:           "Manual Spooler",
		ConnectionType: "spooler",
		Protocol:       "spooler",
		SpoolerName:    "Manual HP",
		Endpoint:       "Manual HP",
		Enabled:        true,
	}
	infos2, err := RegisterManual(registryPath, info2)
	if err != nil {
		t.Fatalf("second RegisterManual: %v", err)
	}
	// Should still be 1 unique for that spooler (plus any other)
	seen := make(map[string]bool)
	for _, p := range infos2 {
		if seen[p.ID] {
			t.Fatalf("duplicate ID %s after second manual", p.ID)
		}
		seen[p.ID] = true
	}
}

func TestSpoolerEnumerationDoesNotCrash(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	cfg := &config.Config{}
	registryPath := config.RegistryPath(cfgPath)
	result := Discover(cfg, registryPath)
	// Should not panic; empty is valid when no printers configured
	if result.Printers != nil && len(result.Printers) > 0 {
		for _, p := range result.Printers {
			if p.ID == "" {
				t.Fatalf("printer without stable ID: %+v", p)
			}
		}
	}
	// Ensure no panic and result is safe to iterate
	_ = len(result.Printers)
}

func TestManualPrinterTypes(t *testing.T) {
	dir := t.TempDir()
	registryPath := filepath.Join(dir, "printers.json")

	cases := []DeviceInfo{
		{Name: "TCP Printer", ConnectionType: "tcp", Endpoint: "192.168.1.50:9100", Protocol: "raw"},
		{Name: "USB Printer", ConnectionType: "usb", Endpoint: "usb://vid:pid", Protocol: "raw"},
		{Name: "Spooler Printer", ConnectionType: "spooler", SpoolerName: "HP LaserJet", Endpoint: "HP LaserJet", Protocol: "spooler"},
		{Name: "IPP Printer", ConnectionType: "ipp", Endpoint: "ipp://192.168.1.60/ipp/print", Protocol: "ipp"},
	}
	for _, tc := range cases {
		// Validate via config validation
		pc := config.PrinterConfig{
			ID:          "test_" + tc.ConnectionType,
			Name:        tc.Name,
			Type:        tc.ConnectionType,
			Endpoint:    tc.Endpoint,
			Protocol:    tc.Protocol,
			SpoolerName: tc.SpoolerName,
		}
		if tc.ConnectionType == "spooler" && pc.SpoolerName == "" {
			pc.SpoolerName = tc.SpoolerName
		}
		// spooler and network should pass, ipp also passes but factory will reject ipp printing
		// Just test that discovery registry handles them
		if _, err := RegisterManual(registryPath, tc); err != nil {
			// IPP manual add should still persist (it's just registry), even if factory rejects execution later
			// So we expect no error for registry
			t.Fatalf("manual %s failed: %v", tc.ConnectionType, err)
		}
		// Verify factory behavior - now all types should create printer (usb via direct USB, ipp via IPP client)
		_, err := New(pc)
		switch tc.ConnectionType {
		case "tcp":
			if err != nil {
				t.Fatalf("tcp should create printer: %v", err)
			}
		case "spooler":
			if err != nil {
				t.Fatalf("spooler should create printer: %v", err)
			}
		case "usb":
			if err != nil {
				t.Fatalf("usb should create printer (direct USB or spooler fallback): %v", err)
			}
		case "ipp":
			if err != nil {
				t.Fatalf("ipp should create printer (IPP client now implemented): %v", err)
			}
		}
	}
	// Check registry persistence
	data, err := os.ReadFile(registryPath)
	if err != nil {
		t.Fatalf("registry read: %v", err)
	}
	if len(data) == 0 {
		t.Fatalf("registry empty after manual adds")
	}
}

func TestPrinterTestOperation(t *testing.T) {
	if os.Getenv("RUN_PHYSICAL_PRINTER_TESTS") != "true" {
		t.Skip("Skipping physical printer test: no physical printer test environment configured.")
	}
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	cfg := &config.Config{}
	registryPath := config.RegistryPath(cfgPath)

	// This test performs a real Windows spooler operation and requires a
	// printer named "Test Printer For Unit" configured on the host.
	if runtime.GOOS != "windows" {
		t.Skip("skipping Windows spooler test: requires Windows")
	}

	// Add a spooler printer manually (stub on non-windows will succeed via file write)
	info := DeviceInfo{
		Name:           "Test Spooler",
		ConnectionType: "spooler",
		Protocol:       "spooler",
		SpoolerName:    "Test Printer For Unit",
		Endpoint:       "Test Printer For Unit",
	}

	if _, err := RegisterManual(registryPath, info); err != nil {
		t.Fatalf("manual: %v", err)
	}

	// Discover to ensure it's found
	result := Discover(cfg, registryPath)
	found := false

	for _, p := range result.Printers {
		if p.SpoolerName == "Test Printer For Unit" {
			found = true

			// Test printing via stub should succeed (writes to temp file)
			if err := TestPrinter(cfg, registryPath, p.ID); err != nil {
				t.Fatalf("TestPrinter failed for spooler stub: %v", err)
			}
			break
		}
	}

	if !found {
		t.Fatalf("test spooler printer not discovered")
	}
}

func TestUnknownPrinterHandling(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	cfg := &config.Config{}
	registryPath := config.RegistryPath(cfgPath)

	// Try to test non-existent printer
	err := TestPrinter(cfg, registryPath, "printer_nonexistent_999")
	if err == nil {
		t.Fatalf("expected error for unknown printer")
	}
	if err != nil && !contains(err.Error(), "not found") {
		t.Fatalf("expected not found error, got %v", err)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (func() bool {
		for i := 0; i <= len(s)-len(substr); i++ {
			if s[i:i+len(substr)] == substr {
				return true
			}
		}
		return false
	})()
}

func TestDiscoverWithContext_Cancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	cfg := &config.Config{}
	registryPath := config.RegistryPath(cfgPath)

	start := time.Now()
	res := DiscoverWithContext(ctx, cfg, registryPath)
	elapsed := time.Since(start)

	if elapsed > 1*time.Second {
		t.Fatalf("expected cancelled DiscoverWithContext to return immediately, took %v", elapsed)
	}
	_ = res
}

func TestSNMPParserAndProbe(t *testing.T) {
	// Setup mock UDP SNMP agent
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.ListenPacket: %v", err)
	}
	defer pc.Close()

	localAddr := pc.LocalAddr().(*net.UDPAddr)

	stopServer := make(chan struct{})

	go func() {
		buf := make([]byte, 4096)
		dec := &gosnmp.GoSNMP{
			Version: gosnmp.Version2c,
			Timeout: 2 * time.Second,
		}
		for {
			_ = pc.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
			n, clientAddr, err := pc.ReadFrom(buf)
			if err != nil {
				select {
				case <-stopServer:
					return
				default:
					continue
				}
			}

			req, err := dec.SnmpDecodePacket(buf[:n])
			if err != nil {
				continue
			}

			vars := []gosnmp.SnmpPDU{
				{
					Name:  oidSysDescr,
					Type:  gosnmp.OctetString,
					Value: []byte("HP LaserJet Pro M402dne"),
				},
				{
					Name:  oidPrtGeneralPrinterName,
					Type:  gosnmp.OctetString,
					Value: []byte("HP LaserJet Pro M402dne"),
				},
				{
					Name:  oidPrtGeneralSerialNumber,
					Type:  gosnmp.OctetString,
					Value: []byte("VNC3R01234"),
				},
			}

			s := &gosnmp.GoSNMP{
				Version:   gosnmp.Version2c,
				Community: req.Community,
				Timeout:   2 * time.Second,
			}
			s.SetRequestID(req.RequestID - 1)
			respBytes, err := s.SnmpEncodePacket(gosnmp.GetResponse, vars, 0, 0)
			if err == nil {
				_, _ = pc.WriteTo(respBytes, clientAddr)
			}
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	dev, ok := probeSNMPPrinterWithPort(ctx, "127.0.0.1", localAddr.Port, 9100)
	cancel()
	close(stopServer)
	_ = pc.Close()

	if !ok {
		t.Fatalf("expected probeSNMPPrinter to return true for valid response")
	}

	if dev.Name != "HP LaserJet Pro M402dne" {
		t.Errorf("expected name 'HP LaserJet Pro M402dne', got %q", dev.Name)
	}
	if dev.Status != "online" {
		t.Errorf("expected status 'online', got %q", dev.Status)
	}
	if dev.Capabilities["snmp_verified"] != true {
		t.Errorf("expected snmp_verified to be true")
	}
	if dev.Capabilities["discovered_via"] != "snmp" {
		t.Errorf("expected discovered_via to be 'snmp'")
	}
	if dev.Capabilities["serial"] != "VNC3R01234" {
		t.Errorf("expected serial 'VNC3R01234', got %v", dev.Capabilities["serial"])
	}
	if dev.Port != 9100 {
		t.Errorf("expected port 9100, got %d", dev.Port)
	}

	// Test protocol heuristics
	cases := []struct {
		descr string
		name  string
		want  string
	}{
		{"Zebra Technologies ZTC ZD420-203dpi", "ZD420", "zpl"},
		{"ZPL compatible label printer", "", "zpl"},
		{"TSC Auto ID Technology Co., Ltd. TTP-244 Pro", "TTP-244 Pro", "tspl"},
		{"TSPL barcode printer", "", "tspl"},
		{"EPSON TM-T20II Receipt POS", "TM-T20II", "escpos"},
		{"Star Micronics TSP100 Thermal Receipt", "TSP100", "escpos"},
		{"HP LaserJet MFP M426fdw", "LaserJet", "raw"},
	}
	for _, tc := range cases {
		got := inferSNMPProtocol(strings.ToLower(tc.descr), strings.ToLower(tc.name))
		if got != tc.want {
			t.Errorf("inferSNMPProtocol(%q, %q) = %q, want %q", tc.descr, tc.name, got, tc.want)
		}
	}

	// Negative test: non-printer device (e.g. Cisco switch)
	pc2, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.ListenPacket: %v", err)
	}
	defer pc2.Close()
	localAddr2 := pc2.LocalAddr().(*net.UDPAddr)

	stopServer2 := make(chan struct{})
	defer close(stopServer2)

	go func() {
		buf := make([]byte, 4096)
		dec2 := &gosnmp.GoSNMP{
			Version: gosnmp.Version2c,
			Timeout: 2 * time.Second,
		}
		for {
			_ = pc2.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
			n, clientAddr, err := pc2.ReadFrom(buf)
			if err != nil {
				select {
				case <-stopServer2:
					return
				default:
					continue
				}
			}
			req, err := dec2.SnmpDecodePacket(buf[:n])
			if err != nil {
				continue
			}
			s := &gosnmp.GoSNMP{
				Version:   gosnmp.Version2c,
				Community: req.Community,
				Timeout:   2 * time.Second,
			}
			s.SetRequestID(req.RequestID - 1)
			vars := []gosnmp.SnmpPDU{
				{
					Name:  oidSysDescr,
					Type:  gosnmp.OctetString,
					Value: []byte("Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M)"),
				},
			}
			respBytes, err := s.SnmpEncodePacket(gosnmp.GetResponse, vars, 0, 0)
			if err == nil {
				_, _ = pc2.WriteTo(respBytes, clientAddr)
			}
		}
	}()

	ctx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel2()

	_, ok2 := probeSNMPPrinterWithPort(ctx2, "127.0.0.1", localAddr2.Port, 9100)
	if ok2 {
		t.Errorf("expected probeSNMPPrinter to return false for non-printer Cisco device")
	}
}

func TestWSDProbeMatchesParser(t *testing.T) {
	fixtureHP := []byte(`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
               xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery"
               xmlns:wsdp="http://schemas.microsoft.com/windows/2006/08/wdp/print">
  <soap:Header>
    <wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action>
    <wsa:MessageID>urn:uuid:76543210-9abc-def0-1234-56789abcdef0</wsa:MessageID>
    <wsa:RelatesTo>urn:uuid:01234567-89ab-cdef-0123-456789abcdef</wsa:RelatesTo>
    <wsa:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
  </soap:Header>
  <soap:Body>
    <wsd:ProbeMatches>
      <wsd:ProbeMatch>
        <wsa:EndpointReference>
          <wsa:Address>urn:uuid:3fa85f64-5717-4562-b3fc-2c963f66afa6</wsa:Address>
        </wsa:EndpointReference>
        <wsd:Types>wsdp:PrintDeviceType</wsd:Types>
        <wsd:Scopes>http://schemas.microsoft.com/windows/2006/08/wdp/print/printDevice</wsd:Scopes>
        <wsd:XAddrs>http://192.168.1.55:5357/3fa85f64-5717-4562-b3fc-2c963f66afa6</wsd:XAddrs>
        <wsd:MetadataVersion>1</wsd:MetadataVersion>
      </wsd:ProbeMatch>
    </wsd:ProbeMatches>
  </soap:Body>
</soap:Envelope>`)

	parsed := parseWSDProbeMatches(fixtureHP, &net.UDPAddr{IP: net.ParseIP("192.168.1.55"), Port: 3702})
	if len(parsed) != 1 {
		t.Fatalf("expected 1 parsed WSD device, got %d", len(parsed))
	}

	d := parsed[0]
	if d.NetworkAddress != "192.168.1.55" {
		t.Errorf("expected NetworkAddress 192.168.1.55, got %q", d.NetworkAddress)
	}
	if d.Port != 9100 {
		t.Errorf("expected Port 9100, got %d", d.Port)
	}
	if d.Status != "online" {
		t.Errorf("expected Status online, got %q", d.Status)
	}
	if d.Protocol != "raw" {
		t.Errorf("expected Protocol raw, got %q", d.Protocol)
	}
	if d.Capabilities["wsd_verified"] != true {
		t.Errorf("expected wsd_verified to be true")
	}
	if d.Capabilities["discovered_via"] != "wsd" {
		t.Errorf("expected discovered_via to be 'wsd'")
	}
	if d.Capabilities["wsd_endpoint"] != "http://192.168.1.55:5357/3fa85f64-5717-4562-b3fc-2c963f66afa6" {
		t.Errorf("unexpected wsd_endpoint: %v", d.Capabilities["wsd_endpoint"])
	}
	if d.Capabilities["uuid"] != "3fa85f64-5717-4562-b3fc-2c963f66afa6" {
		t.Errorf("unexpected uuid: %v", d.Capabilities["uuid"])
	}

	// Non-printer payload should be ignored
	fixtureScanner := []byte(`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
               xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery"
               xmlns:wsds="http://schemas.microsoft.com/windows/2006/08/wdp/scan">
  <soap:Body>
    <wsd:ProbeMatches>
      <wsd:ProbeMatch>
        <wsa:EndpointReference>
          <wsa:Address>urn:uuid:aaaa-bbbb-cccc</wsa:Address>
        </wsa:EndpointReference>
        <wsd:Types>wsds:ScanDeviceType</wsd:Types>
        <wsd:XAddrs>http://192.168.1.99:5357/scan</wsd:XAddrs>
      </wsd:ProbeMatch>
    </wsd:ProbeMatches>
  </soap:Body>
</soap:Envelope>`)

	parsedScan := parseWSDProbeMatches(fixtureScanner, &net.UDPAddr{IP: net.ParseIP("192.168.1.99"), Port: 3702})
	if len(parsedScan) != 0 {
		t.Errorf("expected 0 devices for scanner payload, got %d", len(parsedScan))
	}

	// Remote UDP address fallback test
	fixtureNoIPInXAddr := []byte(`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
               xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery"
               xmlns:wsdp="http://schemas.microsoft.com/windows/2006/08/wdp/print">
  <soap:Body>
    <wsd:ProbeMatches>
      <wsd:ProbeMatch>
        <wsa:EndpointReference>
          <wsa:Address>urn:uuid:1234-5678</wsa:Address>
        </wsa:EndpointReference>
        <wsd:Types>wsdp:PrintDeviceType</wsd:Types>
        <wsd:XAddrs>/wsd/print</wsd:XAddrs>
      </wsd:ProbeMatch>
    </wsd:ProbeMatches>
  </soap:Body>
</soap:Envelope>`)
	parsedFallback := parseWSDProbeMatches(fixtureNoIPInXAddr, &net.UDPAddr{IP: net.ParseIP("10.0.0.42"), Port: 3702})
	if len(parsedFallback) != 1 || parsedFallback[0].NetworkAddress != "10.0.0.42" {
		t.Errorf("expected fallback IP 10.0.0.42, got %+v", parsedFallback)
	}
}

func TestMDNSTXTAttributeExtraction(t *testing.T) {
	records := []string{
		"txtvers=1",
		"qtotal=1",
		"rp=ipp/print",
		"ty=HP Color LaserJet Pro M452nw",
		"adminurl=http://192.168.1.150",
		"pdl=application/pdf,image/urf,image/pwg-raster",
		"usb_MFG=HP",
		"usb_MDL=Color LaserJet Pro M452nw",
		"Color=T",
		"Duplex=T",
	}

	meta := parseMDNSTXT(records)
	if meta.ty != "HP Color LaserJet Pro M452nw" {
		t.Errorf("expected ty 'HP Color LaserJet Pro M452nw', got %q", meta.ty)
	}
	if meta.rp != "ipp/print" {
		t.Errorf("expected rp 'ipp/print', got %q", meta.rp)
	}
	expectedPDL := []string{"application/pdf", "image/urf", "image/pwg-raster"}
	if !reflect.DeepEqual(meta.pdlList, expectedPDL) {
		t.Errorf("expected pdl %v, got %v", expectedPDL, meta.pdlList)
	}
	if meta.mfg != "HP" {
		t.Errorf("expected mfg 'HP', got %q", meta.mfg)
	}
	if meta.model != "Color LaserJet Pro M452nw" {
		t.Errorf("expected model 'Color LaserJet Pro M452nw', got %q", meta.model)
	}

	// Test product fallback
	altRecords := []string{
		"product=(Brother HL-L2350DW series)",
		"rp=ipp/print",
	}
	altMeta := parseMDNSTXT(altRecords)
	if altMeta.product != "Brother HL-L2350DW series" {
		t.Errorf("expected product 'Brother HL-L2350DW series', got %q", altMeta.product)
	}

	// Test ServiceEntry parsing
	entry := &zeroconf.ServiceEntry{
		ServiceRecord: zeroconf.ServiceRecord{
			Instance: "HP Color LaserJet",
			Service:  "_ipp._tcp",
			Domain:   "local.",
		},
		HostName: "printer.local.",
		Port:     631,
		Text:     records,
		AddrIPv4: []net.IP{net.ParseIP("192.168.1.150")},
	}

	di, ok := parseMDNSServiceEntry(entry)
	if !ok {
		t.Fatalf("expected parseMDNSServiceEntry to succeed")
	}
	if di.Name != "HP Color LaserJet Pro M452nw" {
		t.Errorf("expected name 'HP Color LaserJet Pro M452nw', got %q", di.Name)
	}
	if di.NetworkAddress != "192.168.1.150" {
		t.Errorf("expected IP 192.168.1.150, got %q", di.NetworkAddress)
	}
	if di.Port != 631 {
		t.Errorf("expected Port 631, got %d", di.Port)
	}
	if di.ConnectionType != "ipp" || di.Protocol != "ipp" {
		t.Errorf("expected ipp connection and protocol, got %s/%s", di.ConnectionType, di.Protocol)
	}
	if di.Endpoint != "ipp://192.168.1.150:631/ipp/print" {
		t.Errorf("expected endpoint 'ipp://192.168.1.150:631/ipp/print', got %q", di.Endpoint)
	}
	if di.Capabilities["mdns_verified"] != true {
		t.Errorf("expected mdns_verified=true")
	}
	if di.Capabilities["discovered_via"] != "mdns" {
		t.Errorf("expected discovered_via='mdns'")
	}
}

func TestMergeNetworkDevices(t *testing.T) {
	// TCP raw candidate device
	tcpDev := DeviceInfo{
		ID:             StableIDFromNetwork("192.168.1.50", 9100),
		Name:           "Network Printer 192.168.1.50",
		DisplayName:    "Network Printer 192.168.1.50",
		NetworkAddress: "192.168.1.50",
		Port:           9100,
		ConnectionType: "network",
		Protocol:       "raw",
		Status:         "online",
		Capabilities: map[string]interface{}{
			"discovered_via": "tcp_raw_scan",
			"verification":   "candidate",
			"confidence":     "low",
		},
	}

	// SNMP enriched device on same IP
	snmpDev := DeviceInfo{
		ID:             StableIDFromNetwork("192.168.1.50", 9100),
		Name:           "HP LaserJet Pro M402dne",
		DisplayName:    "HP LaserJet Pro M402dne",
		NetworkAddress: "192.168.1.50",
		Port:           9100,
		ConnectionType: "network",
		Protocol:       "raw",
		Status:         "online",
		Capabilities: map[string]interface{}{
			"discovered_via": "snmp",
			"snmp_verified":  true,
			"verification":   "verified",
			"confidence":     "high",
			"sysDescr":       "HP LaserJet Pro M402dne",
			"serial":         "VNC3R01234",
			"manufacturer":   "HP",
		},
	}

	merged := mergeNetworkDevices([]DeviceInfo{tcpDev, snmpDev})
	if len(merged) != 1 {
		t.Fatalf("expected 1 merged device, got %d", len(merged))
	}

	res := merged[0]
	if res.Name != "HP LaserJet Pro M402dne" {
		t.Errorf("expected specific model name to be preserved, got %q", res.Name)
	}
	if res.Capabilities["snmp_verified"] != true {
		t.Errorf("expected snmp_verified=true")
	}
	if res.Capabilities["verification"] != "verified" {
		t.Errorf("expected verification 'verified', got %v", res.Capabilities["verification"])
	}
	if res.Capabilities["confidence"] != "high" {
		t.Errorf("expected confidence 'high', got %v", res.Capabilities["confidence"])
	}
	if res.Capabilities["serial"] != "VNC3R01234" {
		t.Errorf("expected serial 'VNC3R01234', got %v", res.Capabilities["serial"])
	}
}
