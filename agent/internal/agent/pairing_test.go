package agent

import (
	"testing"
)

func TestValidateServerURLRejectsHTTPByDefault(t *testing.T) {
	t.Setenv("ODOO_PRINT_AGENT_ENV", "")
	t.Setenv("ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP", "")
	if err := validateServerURL("http://127.0.0.1:3000"); err == nil {
		t.Fatal("expected HTTP URL to be rejected by default")
	}
}

func TestValidateServerURLAllowsHTTPOnlyInExplicitDevelopment(t *testing.T) {
	t.Setenv("ODOO_PRINT_AGENT_ENV", "development")
	t.Setenv("ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP", "1")
	if err := validateServerURL("http://127.0.0.1:3000"); err != nil {
		t.Fatalf("expected explicit development HTTP URL to be accepted, got %v", err)
	}
}

func TestValidateServerURLRejectsHTTPWhenOnlyFlagIsPresent(t *testing.T) {
	t.Setenv("ODOO_PRINT_AGENT_ENV", "production")
	t.Setenv("ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP", "1")
	if err := validateServerURL("http://gateway.example.com"); err == nil {
		t.Fatal("expected HTTP URL to remain rejected outside development")
	}
}
