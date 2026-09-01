package printer

import (
	"os"
	"path/filepath"
	"testing"

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
			ID:   "test_" + tc.ConnectionType,
			Name: tc.Name,
			Type: tc.ConnectionType,
			Endpoint: tc.Endpoint,
			Protocol: tc.Protocol,
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
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	cfg := &config.Config{}
	registryPath := config.RegistryPath(cfgPath)

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
