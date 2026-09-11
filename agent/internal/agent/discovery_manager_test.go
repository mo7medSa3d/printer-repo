package agent

import (
	"testing"

	"github.com/odoo-print-agent/agent/internal/printer"
)

func TestDiscoveryVerificationDoesNotTrustWSDAsPrintVerification(t *testing.T) {
	di := printer.DeviceInfo{
		Protocol: "", ConnectionType: "network",
		Capabilities: map[string]interface{}{"wsd_verified": true},
	}
	if got := discoveryVerification(di); got != "candidate" {
		t.Fatalf("stale WSD verification must remain candidate, got %q", got)
	}
}
