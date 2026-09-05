package printer

import "testing"

func TestStableIDForDevicePrefersUUID(t *testing.T) {
	d := DeviceInfo{
		Name:           "Office Printer",
		NetworkAddress: "192.168.1.50",
		Port:           631,
		Capabilities: map[string]interface{}{
			"uuid": "urn:uuid:12345678-1234-4123-8123-123456789abc",
		},
	}

	got := StableIDForDevice(d)
	want := StableIDFromUUID("urn:uuid:12345678-1234-4123-8123-123456789abc")
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestStableIDFromUUIDIsIndependentOfNetworkAddress(t *testing.T) {
	uuid := "urn:uuid:12345678-1234-4123-8123-123456789abc"
	a := StableIDForDevice(DeviceInfo{
		NetworkAddress: "192.168.1.50",
		Port:           631,
		Capabilities:   map[string]interface{}{"uuid": uuid},
	})
	b := StableIDForDevice(DeviceInfo{
		NetworkAddress: "192.168.1.99",
		Port:           631,
		Capabilities:   map[string]interface{}{"uuid": uuid},
	})
	if a != b {
		t.Fatalf("UUID-backed IDs changed across IPs: %q != %q", a, b)
	}
}
