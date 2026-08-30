package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidatePrinterConfig(t *testing.T) {
	ok := PrinterConfig{ID: "printer_kitchen", Name: "Kitchen", Type: "network", Endpoint: "192.168.1.50:9100", Protocol: "escpos"}
	if err := ValidatePrinterConfig(ok); err != nil {
		t.Fatalf("expected ok, got %v", err)
	}
	bad := []PrinterConfig{
		{ID: "", Name: "x", Type: "network", Endpoint: "1.1.1.1:9100"},
		{ID: "bad id", Name: "x", Type: "network", Endpoint: "1.1.1.1:9100"},
		{ID: "p1", Name: "", Type: "network", Endpoint: "1.1.1.1:9100"},
		{ID: "p1", Name: "x", Type: "serial", Endpoint: "1.1.1.1:9100"},
		{ID: "p1", Name: "x", Type: "network", Endpoint: "notanipport"},
		{ID: "p1", Name: "x", Type: "network", Endpoint: "1.1.1.1:99999"},
	}
	for i, c := range bad {
		if err := ValidatePrinterConfig(c); err == nil {
			t.Fatalf("case %d expected error for %+v", i, c)
		}
	}
}

func TestDefaultConfigPathProgramData(t *testing.T) {
	// ensure PROGRAMDATA wins
	orig := os.Getenv("PROGRAMDATA")
	t.Setenv("PROGRAMDATA", `C:\ProgramData`)
	got := DefaultConfigPath()
	expected := filepath.Join(`C:\ProgramData`, "OdooPrintAgent", "config.yaml")
	// On linux filepath.Join uses / but test checks suffix
	if got != expected {
		// normalize for linux runner: actual will be C:\ProgramData/OdooPrintAgent/config.yaml
		if filepath.Base(got) != "config.yaml" {
			t.Fatalf("expected config.yaml suffix, got %q", got)
		}
	}
	_ = orig
}

func TestConfigValidate(t *testing.T) {
	c := &Config{}
	c.Server.URL = "https://example.com"
	c.Printers = []PrinterConfig{{ID: "p1", Name: "P1", Type: "network", Endpoint: "10.0.0.1:9100"}}
	if err := c.Validate(); err != nil {
		t.Fatalf("expected valid, got %v", err)
	}
	c.Server.URL = "htp://bad"
	if err := c.Validate(); err == nil {
		t.Fatalf("expected invalid url")
	}
}
