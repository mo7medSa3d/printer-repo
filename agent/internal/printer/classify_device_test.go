package printer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/odoo-print-agent/agent/internal/config"
)

/* ============================================================
   Printer classification tests
   ------------------------------------------------------------
   These lock the rule the product depends on: only real
   printing hardware may become a managed printer. Virtual,
   software and session-redirected queues must never be listed,
   registered with the Gateway or selected for a job.

   The classification is metadata driven (port monitor, driver,
   PnP identifiers, transport) — not a printer-name blacklist —
   so the cases below also prove that legitimate network, USB,
   IPP and Windows spooler hardware survives the filter.
   ============================================================ */

func caps(pairs ...string) map[string]interface{} {
	out := map[string]interface{}{}
	for i := 0; i+1 < len(pairs); i += 2 {
		out[pairs[i]] = pairs[i+1]
	}
	return out
}

func TestClassifyVirtualPrintersAreHidden(t *testing.T) {
	cases := []struct {
		name string
		di   DeviceInfo
		want PrinterClass
	}{
		{
			name: "Microsoft Print to PDF",
			di: DeviceInfo{
				Name: "Microsoft Print to PDF", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Microsoft Print to PDF",
				Capabilities: caps("port_name", "PORTPROMPT:", "driver_name", "Microsoft Print To PDF"),
			},
			want: ClassVirtual,
		},
		{
			name: "Microsoft XPS Document Writer",
			di: DeviceInfo{
				Name: "Microsoft XPS Document Writer", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Microsoft XPS Document Writer",
				Capabilities: caps("port_name", "XPSPort:", "driver_name", "Microsoft XPS Document Writer"),
			},
			want: ClassVirtual,
		},
		{
			name: "OneNote",
			di: DeviceInfo{
				Name: "OneNote", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "OneNote",
				Capabilities: caps("port_name", "nul:", "driver_name", "Send to Microsoft OneNote 16 Driver"),
			},
			want: ClassVirtual,
		},
		{
			name: "OneNote (Desktop)",
			di: DeviceInfo{
				Name: "OneNote (Desktop)", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "OneNote (Desktop)",
				Capabilities: caps("port_name", "nul:", "driver_name", "Send to Microsoft OneNote 16 Driver"),
			},
			want: ClassVirtual,
		},
		{
			name: "Fax",
			di: DeviceInfo{
				Name: "Fax", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Fax",
				Capabilities: caps("port_name", "SHRFAX:", "driver_name", "Microsoft Shared Fax Driver"),
			},
			want: ClassVirtual,
		},
		{
			name: "point and print compatibility driver",
			di: DeviceInfo{
				Name: "Compat Queue", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Compat Queue",
				Capabilities: caps("port_name", "192.168.1.9", "driver_name", "Microsoft enhanced Point and Print compatibility driver"),
			},
			want: ClassVirtual,
		},
		{
			name: "third party PDF writer on a USB-looking port",
			di: DeviceInfo{
				Name: "Foxit PDF Printer", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Foxit PDF Printer",
				Capabilities: caps("port_name", "USB001", "driver_name", "Foxit Reader PDF Printer Driver"),
			},
			want: ClassVirtual,
		},
		{
			name: "print to file port",
			di: DeviceInfo{
				Name: "Archive Queue", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Archive Queue",
				Capabilities: caps("port_name", "FILE:", "driver_name", "Generic / Text Only"),
			},
			want: ClassVirtual,
		},
		{
			name: "virtual queue persisted by an older version",
			di: DeviceInfo{
				Name:           "Legacy Software Queue",
				ConnectionType: "spooler",
				Protocol:       "spooler",
				SpoolerName:    "Legacy Software Queue",
				IsVirtual:      true,
			},
			want: ClassVirtual,
		},
	}

	for _, tc := range cases {
		got := ClassifyDeviceInfo(tc.di)
		if got.Class != tc.want {
			t.Errorf("%s: class = %s, want %s (reasons %v)", tc.name, got.Class, tc.want, got.Reasons)
		}
		if !got.IsVirtual {
			t.Errorf("%s: IsVirtual = false, want true", tc.name)
		}
		if IsProductionPrinter(tc.di) {
			t.Errorf("%s: IsProductionPrinter = true, want false", tc.name)
		}
	}
}

func TestClassifyRedirectedPrintersAreHidden(t *testing.T) {
	cases := []struct {
		name string
		di   DeviceInfo
	}{
		{
			name: "RDP redirected by port + driver",
			di: DeviceInfo{
				Name: "HP LaserJet 1020 (redirected 3)", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "HP LaserJet 1020 (redirected 3)",
				Capabilities: caps("port_name", "TS003", "driver_name", "Remote Desktop Easy Print"),
			},
		},
		{
			name: "RDP redirected by name only",
			di: DeviceInfo{
				Name: "Brother HL-L2360D (redirected 2)", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Brother HL-L2360D (redirected 2)",
				Capabilities: caps("port_name", "TS001", "driver_name", "Brother HL-L2360D"),
			},
		},
		{
			name: "Citrix session queue",
			di: DeviceInfo{
				Name: "Kyocera ECOSYS (from WKS12) in session 4", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Kyocera ECOSYS (from WKS12) in session 4",
				Capabilities: caps("port_name", "USB002", "driver_name", "Citrix Universal Printer Driver"),
			},
		},
	}

	for _, tc := range cases {
		got := ClassifyDeviceInfo(tc.di)
		if got.Class != ClassRedirected {
			t.Errorf("%s: class = %s, want %s (reasons %v)", tc.name, got.Class, ClassRedirected, got.Reasons)
		}
		if !got.IsRedirected {
			t.Errorf("%s: IsRedirected = false, want true", tc.name)
		}
		if !got.IsVirtual {
			t.Errorf("%s: IsVirtual = false, want true (redirected queues are not production printers)", tc.name)
		}
		if IsProductionPrinter(tc.di) {
			t.Errorf("%s: IsProductionPrinter = true, want false", tc.name)
		}
	}
}

func TestClassifyPhysicalPrintersStayVisible(t *testing.T) {
	cases := []struct {
		name string
		di   DeviceInfo
	}{
		{
			name: "physical USB spooler printer",
			di: DeviceInfo{
				Name: "HP LaserJet Pro M404", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "HP LaserJet Pro M404",
				Capabilities: caps("port_name", "USB001", "driver_name", "HP LaserJet Pro M404 PCL 6"),
			},
		},
		{
			name: "physical USB printer with PnP ids",
			di: DeviceInfo{
				Name: "Epson TM-T82II", ConnectionType: "usb", Protocol: "escpos",
				USBVID: "04b8", USBPID: "0202", USBSerial: "CN123",
				Capabilities: map[string]interface{}{
					"hardware_ids":   []string{`USBPRINT\EpsonTM-T82II`},
					"compatible_ids": []string{"USBPRINT"},
				},
			},
		},
		{
			name: "physical TCP/IP printer",
			di: DeviceInfo{
				Name: "Zebra ZD421", ConnectionType: "network", Protocol: "raw",
				NetworkAddress: "192.168.1.62", Port: 9100, Endpoint: "192.168.1.62:9100",
			},
		},
		{
			name: "physical IPP printer",
			di: DeviceInfo{
				Name: "Canon i-SENSYS", ConnectionType: "ipp", Protocol: "ipp",
				Endpoint: "ipp://192.168.1.80/ipp/print",
			},
		},
		{
			name: "Windows spooler queue on a standard TCP/IP port",
			di: DeviceInfo{
				Name: "Ricoh IM C300", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Ricoh IM C300",
				Capabilities: caps("port_name", "192.168.1.50_1", "driver_name", "Ricoh PCL6 UniversalDriver"),
			},
		},
		{
			name: "Windows spooler queue on an IP_ port",
			di: DeviceInfo{
				Name: "Xerox VersaLink", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Xerox VersaLink",
				Capabilities: caps("port_name", "IP_192.168.1.31", "driver_name", "Xerox Global Print Driver"),
			},
		},
		{
			name: "Windows spooler queue over WSD",
			di: DeviceInfo{
				Name: "Office Printer", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Office Printer",
				Capabilities: caps("port_name", "WSD-5f3e7a91", "driver_name", "Generic Laser"),
			},
		},
		{
			name: "physical printer on a vendor port monitor",
			di: DeviceInfo{
				Name: "Brother HL-L2360D", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Brother HL-L2360D",
				Capabilities: caps("port_name", "BRN30055C4B5B4C", "driver_name", "Brother HL-L2360D series"),
			},
		},
		{
			name: "physical thermal receipt printer on LPT",
			di: DeviceInfo{
				Name: "Kitchen Receipt", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Kitchen Receipt",
				Capabilities: caps("port_name", "LPT1:", "driver_name", "Generic / Text Only"),
			},
		},
		{
			name: "manually registered spooler printer",
			di: DeviceInfo{
				Name: "Manual HP", ConnectionType: "spooler", Protocol: "spooler",
				SpoolerName:  "Manual HP",
				Capabilities: map[string]interface{}{"registration_source": "manual"},
			},
		},
	}

	for _, tc := range cases {
		got := ClassifyDeviceInfo(tc.di)
		if got.Class != ClassPhysical {
			t.Errorf("%s: class = %s, want %s (reasons %v)", tc.name, got.Class, ClassPhysical, got.Reasons)
		}
		if got.IsVirtual {
			t.Errorf("%s: IsVirtual = true, want false", tc.name)
		}
		if !IsProductionPrinter(tc.di) {
			t.Errorf("%s: IsProductionPrinter = false, want true", tc.name)
		}
	}
}

func TestClassifyUnknownIsHandledSafely(t *testing.T) {
	// No port, no endpoint, no USB ids, no spooler name: we cannot prove a
	// transport, so discovery must not promote it to a production printer.
	unknown := DeviceInfo{Name: "Mystery Queue", ConnectionType: "network", Protocol: "raw"}
	if got := ClassifyDeviceInfo(unknown); got.Class != ClassUnknown {
		t.Fatalf("class = %s, want %s (reasons %v)", got.Class, ClassUnknown, got.Reasons)
	}
	if IsProductionPrinter(unknown) {
		t.Fatalf("an unclassified discovered queue must not be a production printer")
	}

	// The same queue registered by an operator stays usable: explicit intent
	// outranks missing metadata.
	explicit := unknown
	explicit.Capabilities = map[string]interface{}{"registration_source": "manual"}
	if !IsProductionPrinter(explicit) {
		t.Fatalf("an explicitly registered queue must stay visible")
	}
	explicitConfig := unknown
	explicitConfig.Capabilities = map[string]interface{}{"registration_source": "config"}
	if !IsProductionPrinter(explicitConfig) {
		t.Fatalf("a config.yaml queue must stay visible")
	}
}

func TestClassificationDoesNotRemoveLegitimateHardware(t *testing.T) {
	// A realistic Windows + network fleet: every entry must survive.
	fleet := []DeviceInfo{
		{Name: "HP LaserJet Pro M404", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "HP LaserJet Pro M404", Capabilities: caps("port_name", "USB001")},
		{Name: "Brother HL-Lxxxx series", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Brother HL-L2360D", Capabilities: caps("port_name", "BRN0080777A1B2C")},
		{Name: "Epson TM-T82II", ConnectionType: "usb", Protocol: "escpos", USBVID: "04b8", USBPID: "0202"},
		{Name: "Zebra ZD421", ConnectionType: "network", Protocol: "raw", NetworkAddress: "192.168.1.62", Port: 9100},
		{Name: "Canon i-SENSYS MF643", ConnectionType: "ipp", Protocol: "ipp", Endpoint: "ipp://192.168.1.80/ipp/print"},
		{Name: "Xerox VersaLink C405", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Xerox VersaLink C405", Capabilities: caps("port_name", "IP_192.168.1.31")},
		{Name: "Ricoh MP C3004", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Ricoh MP C3004", Capabilities: caps("port_name", "WSD-ff01a2b3")},
		{Name: "Kyocera ECOSYS P3145dn", ConnectionType: "network", Protocol: "raw", NetworkAddress: "10.0.0.24", Port: 9100},
		{Name: "Bixolon SRP-350III", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Bixolon SRP-350III", Capabilities: caps("port_name", "COM3:", "driver_name", "Bixolon SRP-350III")},
		{Name: "Zebra ZD621", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Zebra ZD621", Capabilities: caps("port_name", "USB002", "driver_name", "ZDesigner ZD621-203dpi ZPL")},
	}
	for _, d := range fleet {
		if !IsProductionPrinter(d) {
			t.Errorf("legitimate printer %q was hidden: class=%s reasons=%v", d.Name, ClassifyDeviceInfo(d).Class, ClassifyDeviceInfo(d).Reasons)
		}
	}
}

func TestVirtualPrintersNeverEnterTheManagedRegistry(t *testing.T) {
	dir := t.TempDir()
	registryPath := filepath.Join(dir, "printers.json")

	physical := DeviceInfo{
		ID: "printer_hp", Name: "HP LaserJet Pro M404", ConnectionType: "spooler",
		Protocol: "spooler", SpoolerName: "HP LaserJet Pro M404", Status: "online", Enabled: true,
		Capabilities: caps("port_name", "USB001", "driver_name", "HP LaserJet Pro M404 PCL 6"),
	}
	virtual := DeviceInfo{
		ID: "printer_pdf", Name: "Microsoft Print to PDF", ConnectionType: "spooler",
		Protocol: "spooler", SpoolerName: "Microsoft Print to PDF", Status: "online", Enabled: true,
		IsVirtual:    true,
		Capabilities: caps("port_name", "PORTPROMPT:", "driver_name", "Microsoft Print To PDF"),
	}

	// Start from the state an older version left behind: both queues persisted.
	if err := SaveRegistry(registryPath, []DeviceInfo{physical, virtual}); err != nil {
		t.Fatalf("seed registry: %v", err)
	}

	merged, err := UpsertRegistry(registryPath, []DeviceInfo{physical})
	if err != nil {
		t.Fatalf("UpsertRegistry: %v", err)
	}
	if len(merged) != 1 || merged[0].ID != "printer_hp" {
		t.Fatalf("expected only the physical printer, got %+v", merged)
	}

	listed, err := loadRegistryPrinters(registryPath)
	if err != nil {
		t.Fatalf("loadRegistryPrinters: %v", err)
	}
	if len(listed) != 1 || listed[0].ID != "printer_hp" {
		t.Fatalf("virtual printer leaked into the managed list: %+v", listed)
	}

	// Hidden records are preserved on disk (never destroyed) so an operator
	// can still inspect what this machine reports.
	raw, err := os.ReadFile(registryPath)
	if err != nil {
		t.Fatalf("read registry: %v", err)
	}
	var onDisk []DeviceInfo
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("parse registry: %v", err)
	}
	if len(onDisk) != 2 {
		t.Fatalf("expected the hidden record to be preserved on disk, got %d entries", len(onDisk))
	}

	// A later discovery that still reports the virtual queue must not
	// resurrect it into the managed set.
	if _, err := UpsertRegistry(registryPath, []DeviceInfo{physical, virtual}); err != nil {
		t.Fatalf("second UpsertRegistry: %v", err)
	}
	listed2, err := loadRegistryPrinters(registryPath)
	if err != nil {
		t.Fatalf("loadRegistryPrinters: %v", err)
	}
	if len(listed2) != 1 || listed2[0].ID != "printer_hp" {
		t.Fatalf("virtual printer was resurrected: %+v", listed2)
	}
}

func TestDiscoveryHidesVirtualQueues(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{}
	registryPath := filepath.Join(dir, "printers.json")

	seed := []DeviceInfo{
		{
			ID: "printer_hp", Name: "HP LaserJet Pro M404", ConnectionType: "spooler",
			Protocol: "spooler", SpoolerName: "HP LaserJet Pro M404", Status: "online", Enabled: true,
			Capabilities: caps("port_name", "USB001", "driver_name", "HP LaserJet Pro M404 PCL 6"),
		},
		{
			ID: "printer_pdf", Name: "Microsoft Print to PDF", ConnectionType: "spooler",
			Protocol: "spooler", SpoolerName: "Microsoft Print to PDF", Status: "online", Enabled: true,
			IsVirtual:    true,
			Capabilities: caps("port_name", "PORTPROMPT:", "driver_name", "Microsoft Print To PDF"),
		},
	}
	if err := SaveRegistry(registryPath, seed); err != nil {
		t.Fatalf("seed registry: %v", err)
	}

	result := DiscoverQuick(cfg, registryPath)
	for _, p := range result.Printers {
		if IsVirtualDevice(p) {
			t.Errorf("discovery returned a virtual printer: %q", p.Name)
		}
	}
	found := false
	for _, p := range result.Printers {
		if p.ID == "printer_hp" {
			found = true
		}
	}
	if !found {
		t.Fatalf("discovery removed the legitimate printer: %+v", result.Printers)
	}
}

func TestIsVirtualSpoolerMatchesClassifier(t *testing.T) {
	// The legacy helper now delegates to the metadata classifier; keep the
	// historical expectations as a cross-check.
	cases := []struct {
		port, driver, name string
		want               bool
	}{
		{"PORTPROMPT:", "Microsoft Print To PDF", "Microsoft Print to PDF", true},
		{"XPSPort:", "Microsoft XPS Document Writer", "Microsoft XPS Document Writer", true},
		{"FILE:", "Generic", "PDF995", true},
		{"nul:", "Generic", "My Printer", true},
		{"SHRFAX:", "Fax Driver", "Fax", true},
		{"IP_192.168.1.50", "Microsoft Print to PDF", "Microsoft Print to PDF", true},
		{"USB001", "HP LaserJet", "HP LaserJet 1020", false},
		{"WSD-abc", "Generic Laser", "Office Printer", false},
		{"IP_192.168.1.10", "Zebra Label", "Zebra GK420", false},
		{"192.168.1.50:9100", "ESC/POS", "Thermal Receipt", false},
		{"USB001", "AnyDesk Printer", "AnyDesk Printer", true},
		{"USB001", "Foxit Reader PDF", "Foxit Printer", true},
	}
	for _, tc := range cases {
		if got := isVirtualSpooler(tc.port, tc.driver, tc.name); got != tc.want {
			t.Errorf("port=%q driver=%q name=%q: got %v want %v", tc.port, tc.driver, tc.name, got, tc.want)
		}
	}
}

func TestUsbDevicePathProvesPhysical(t *testing.T) {
	// A USB printer whose ids do not advertise the print class and whose
	// VID/PID/serial could not be parsed: the device path alone is proof that
	// Plug and Play enumerated real hardware.
	di := DeviceInfo{
		Name: "Receipt Printer", ConnectionType: "usb", Protocol: "raw",
		Endpoint: `\\?\usb#vid_04b8&pid_0202#cn123#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}`,
		Enabled:  true,
		Capabilities: map[string]interface{}{
			"hardware_ids":   []string{`USB\VID_04B8&PID_0202`},
			"compatible_ids": []string{`USB\Class_ff`},
			"device_path":    `\\?\usb#vid_04b8&pid_0202#cn123`,
		},
	}
	got := ClassifyDeviceInfo(di)
	if got.Class != ClassPhysical {
		t.Fatalf("class = %s, want %s (reasons %v)", got.Class, ClassPhysical, got.Reasons)
	}
	if !IsProductionPrinter(di) {
		t.Fatalf("a USB printer with a device path must stay visible")
	}
}

func TestManualRegistrationCannotBypassVirtualChecks(t *testing.T) {
	dir := t.TempDir()
	registryPath := filepath.Join(dir, "printers.json")

	// An operator (or a provisioning script) tries to register a software
	// writer by name. Explicit registration must NOT rescue it.
	pdf := DeviceInfo{
		Name: "Microsoft Print to PDF", ConnectionType: "spooler", Protocol: "spooler",
		SpoolerName: "Microsoft Print to PDF", Enabled: true, Status: "unknown",
		Capabilities: caps("port_name", "PORTPROMPT:"),
	}
	merged, err := RegisterManual(registryPath, pdf)
	if err != nil {
		t.Fatalf("RegisterManual: %v", err)
	}
	if len(merged) != 0 {
		t.Fatalf("manual registration bypassed the virtual check: %+v", merged)
	}

	// A session-redirected queue is refused as well.
	redirected := DeviceInfo{
		Name: "HP LaserJet 1020 (redirected 3)", ConnectionType: "spooler",
		Protocol: "spooler", SpoolerName: "HP LaserJet 1020 (redirected 3)",
		Enabled: true, Status: "unknown",
	}
	if merged, err = RegisterManual(registryPath, redirected); err != nil {
		t.Fatalf("RegisterManual: %v", err)
	}
	if len(merged) != 0 {
		t.Fatalf("manual registration bypassed the redirect check: %+v", merged)
	}

	// Real hardware is still accepted.
	physical := DeviceInfo{
		Name: "HP LaserJet Pro M404", ConnectionType: "spooler", Protocol: "spooler",
		SpoolerName: "HP LaserJet Pro M404", Enabled: true, Status: "unknown",
		Capabilities: caps("port_name", "USB001"),
	}
	if merged, err = RegisterManual(registryPath, physical); err != nil {
		t.Fatalf("RegisterManual: %v", err)
	}
	if len(merged) != 1 || merged[0].SpoolerName != "HP LaserJet Pro M404" {
		t.Fatalf("legitimate manual registration was rejected: %+v", merged)
	}
}

func TestRegistryKeepsThinMetadataPrinters(t *testing.T) {
	dir := t.TempDir()
	registryPath := filepath.Join(dir, "printers.json")

	// A record an older version persisted with almost no metadata: no port,
	// no VID, no endpoint, no spooler name. It must not silently disappear.
	thin := DeviceInfo{
		ID: "printer_old", Name: "Back Office Printer", ConnectionType: "usb",
		Protocol: "raw", Status: "unknown", Enabled: true,
	}
	if err := SaveRegistry(registryPath, []DeviceInfo{thin}); err != nil {
		t.Fatalf("seed registry: %v", err)
	}

	listed, err := loadRegistryPrinters(registryPath)
	if err != nil {
		t.Fatalf("loadRegistryPrinters: %v", err)
	}
	if len(listed) != 1 || listed[0].ID != "printer_old" {
		t.Fatalf("a persisted printer with thin metadata was dropped: %+v", listed)
	}
	// It is still honestly reported as unclassified — we did not fake it.
	if got := ClassifyDeviceInfo(listed[0]); got.Class != ClassUnknown {
		t.Fatalf("class = %s, want %s", got.Class, ClassUnknown)
	}
	if !IsProductionPrinter(listed[0]) {
		t.Fatalf("a persisted printer must stay a production printer")
	}
}

func TestStaleVirtualRowDoesNotBreakPhysicalPrinters(t *testing.T) {
	dir := t.TempDir()
	registryPath := filepath.Join(dir, "printers.json")

	hp := DeviceInfo{
		ID: "printer_hp", Name: "HP LaserJet Pro M404", ConnectionType: "spooler",
		Protocol: "spooler", SpoolerName: "HP LaserJet Pro M404", Status: "online",
		Enabled: true, Capabilities: caps("port_name", "USB001"),
	}
	zebra := DeviceInfo{
		ID: "printer_zebra", Name: "Zebra ZD421", ConnectionType: "network",
		Protocol: "raw", NetworkAddress: "192.168.1.62", Port: 9100, Status: "online",
		Enabled: true,
	}
	pdf := DeviceInfo{
		ID: "printer_pdf", Name: "Microsoft Print to PDF", ConnectionType: "spooler",
		Protocol: "spooler", SpoolerName: "Microsoft Print to PDF", Status: "online",
		Enabled: true, IsVirtual: true, Capabilities: caps("port_name", "PORTPROMPT:"),
	}
	// Registry as an older version would have left it.
	if err := SaveRegistry(registryPath, []DeviceInfo{hp, pdf, zebra}); err != nil {
		t.Fatalf("seed registry: %v", err)
	}

	// Discovery re-reports everything, including the virtual queue.
	merged, err := UpsertRegistry(registryPath, []DeviceInfo{hp, pdf, zebra})
	if err != nil {
		t.Fatalf("UpsertRegistry: %v", err)
	}
	if len(merged) != 2 {
		t.Fatalf("expected the two physical printers, got %+v", merged)
	}
	byID := map[string]DeviceInfo{}
	for _, d := range merged {
		byID[d.ID] = d
	}
	if _, ok := byID["printer_pdf"]; ok {
		t.Fatalf("virtual printer survived: %+v", merged)
	}
	for _, id := range []string{"printer_hp", "printer_zebra"} {
		d, ok := byID[id]
		if !ok {
			t.Fatalf("physical printer %q was lost", id)
		}
		if !d.Enabled {
			t.Errorf("physical printer %q lost its state (enabled=false)", id)
		}
	}
	if byID["printer_zebra"].NetworkAddress != "192.168.1.62" || byID["printer_zebra"].Port != 9100 {
		t.Errorf("physical printer lost its transport metadata: %+v", byID["printer_zebra"])
	}
}
