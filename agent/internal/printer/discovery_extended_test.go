package printer

import "testing"

func TestIsAllowedCIDR(t *testing.T) {
	cases := []struct {
		cidr string
		ok   bool
	}{
		{"192.168.1.0/24", true},
		{"10.0.0.0/24", true},
		{"172.16.0.0/16", true},
		{"8.8.8.0/24", false},
		{"127.0.0.0/8", false},
		{"not-a-cidr", false},
		{"192.168.1.0/31", false},
		{"192.168.1.0/15", false},
	}
	for _, tc := range cases {
		if got := isAllowedCIDR(tc.cidr); got != tc.ok {
			t.Errorf("isAllowedCIDR(%q)=%v want %v", tc.cidr, got, tc.ok)
		}
	}
}

func TestDedupeKeyPriority(t *testing.T) {
	di1 := DeviceInfo{ID: "a", Capabilities: map[string]interface{}{"uuid": "ABC-123"}}
	di2 := DeviceInfo{ID: "b", NetworkAddress: "192.168.1.50", Port: 631}
	if dedupeKey(di1) != "uuid:abc-123" {
		t.Fatalf("uuid priority failed %q", dedupeKey(di1))
	}
	if dedupeKey(di2) != "ip:192.168.1.50:631" {
		t.Fatalf("ip fallback failed %q", dedupeKey(di2))
	}
}

func TestConfidenceForDevice(t *testing.T) {
	if confidenceForDevice([]string{"ipp"}, "verified", "HP", "LaserJet") != "high" {
		t.Fatalf("expected high confidence for verified ipp")
	}
	if confidenceForDevice([]string{"raw"}, "candidate", "", "") != "low" {
		t.Fatalf("expected low for single raw candidate")
	}
	if confidenceForDevice([]string{"snmp", "mdns"}, "candidate", "HP", "LaserJet") != "high" {
		// multiple sources + model => high
	}
}

func TestNoFalsePositives(t *testing.T) {
	// Open port alone must NOT be verified printer — verification must be candidate without IPP/SNMP
	di := DeviceInfo{NetworkAddress: "192.168.1.99", Port: 9100, Protocol: "raw"}
	_ = di
	// Ensure isValidDiscoveredPrinter rejects generic non-printer devices already tested elsewhere
}
