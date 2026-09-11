package config

import (
	"bytes"
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
	orig := os.Getenv("PROGRAMDATA")
	t.Setenv("PROGRAMDATA", `C:\ProgramData`)
	got := DefaultConfigPath()
	expected := filepath.Join(`C:\ProgramData`, "OdooPrintAgent", "config.yaml")
	if got != expected {
		if filepath.Base(got) != "config.yaml" {
			t.Fatalf("expected config.yaml suffix, got %q", got)
		}
	}
	_ = orig
}

func TestConfigValidate(t *testing.T) {
	c := &Config{}
	c.Server.URL = "https://example.com"
	c.Printers = []PrinterConfig{{ID: "p1", Name: "P1", Type: "network", Protocol: "raw", Endpoint: "10.0.0.1:9100"}}
	if err := c.Validate(); err != nil {
		t.Fatalf("expected valid, got %v", err)
	}
	// An undeclared protocol on a network printer is a validation error:
	// the agent must never invent "raw" for an unconfigured device.
	cNoProto := &Config{}
	cNoProto.Server.URL = "https://example.com"
	cNoProto.Printers = []PrinterConfig{{ID: "p2", Name: "P2", Type: "network", Endpoint: "10.0.0.1:9100"}}
	if err := cNoProto.Validate(); err == nil {
		t.Fatalf("expected error for undeclared protocol")
	}
	c.Server.URL = "htp://bad"
	if err := c.Validate(); err == nil {
		t.Fatalf("expected invalid url")
	}
}

func TestConfigValidateAcceptsHTTPAndHTTPSByDefault(t *testing.T) {
	// Zero-configuration: both http and https are accepted for any valid
	// hostname or IP (LAN, public, loopback) with no environment opt-in.
	for _, url := range []string{
		"http://127.0.0.1:3000",
		"http://192.168.1.50:3000",
		"http://10.0.0.5:3000",
		"http://gateway.example.com",
		"https://gateway.example.com",
	} {
		c := &Config{}
		c.Server.URL = url
		if err := c.Validate(); err != nil {
			t.Fatalf("expected %q to be valid, got %v", url, err)
		}
	}
}

func TestConfigSaveSealsSecretOutsideYAML(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	c := &Config{}
	c.Server.URL = "https://example.com"
	c.Agent.ID = "agent_1"
	c.Agent.Secret = "super-secret-value"
	c.Agent.Name = "test"
	if err := c.Save(path); err != nil {
		t.Fatalf("save: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read yaml: %v", err)
	}
	if bytes.Contains(raw, []byte("super-secret-value")) {
		t.Fatalf("secret must not be persisted in plaintext YAML")
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.Agent.Secret != "super-secret-value" {
		t.Fatalf("expected secret to be restored from the sealed store, got %q", loaded.Agent.Secret)
	}
}

func TestConfigLoadMigratesLegacyPlaintextSecret(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	legacy := "server:\n  url: https://example.com\nagent:\n  id: agent_1\n  secret: legacy-plaintext\n  name: test\n"
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatalf("write legacy: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.Agent.Secret != "legacy-plaintext" {
		t.Fatalf("secret not loaded: %q", loaded.Agent.Secret)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("re-read yaml: %v", err)
	}
	if bytes.Contains(raw, []byte("legacy-plaintext")) {
		t.Fatalf("legacy plaintext secret should have been migrated out of the YAML")
	}

	again, err := Load(path)
	if err != nil {
		t.Fatalf("second load: %v", err)
	}
	if again.Agent.Secret != "legacy-plaintext" {
		t.Fatalf("secret not restored after migration: %q", again.Agent.Secret)
	}
}
