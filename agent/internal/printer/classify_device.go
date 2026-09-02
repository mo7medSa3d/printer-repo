package printer

import (
	"fmt"
	"strings"
)

/* ============================================================
   Printer classification — physical vs virtual vs redirected
   ------------------------------------------------------------
   The Odoo Print Gateway must only ever route production work to
   REAL printing hardware. Windows, however, installs a software
   print queue for a great many things that never touch paper:

       Microsoft Print to PDF      (writes a .pdf file)
       Microsoft XPS Document Writer (writes an .xps file)
       OneNote / OneNote (Desktop) (sends the job to an app)
       Fax / Microsoft Shared Fax  (dials a modem)
       AnyDesk Printer, Foxit, CutePDF, PDF995, PDF24 … (file writers)
       "HP LaserJet (redirected 3)" (RDP session virtual channel)

   Matching printer NAMES is not enough: names are localised,
   vendors ship new writers constantly, and a legitimately named
   queue can sit on a virtual port. So classification is built
   from device METADATA, in this order of authority:

     1. port monitor      — PORTPROMPT:/XPSPORT:/FILE:/NUL:/SHRFAX:
                            are output ports, never hardware
     2. driver / PnP ids  — software writer families
     3. session signals   — RDP / Citrix / VMware redirected queues
     4. transport proof   — USB print class, USB VID/PID, network
                            endpoint, IPP endpoint, hardware port
                            (USB001, WSD…, IP_…, LPT1:, COM1:,
                            host:port, IP)

   Only a device classified `physical` becomes a managed printer.
   `virtual` and `redirected` queues are kept in the local registry
   (so nothing is destroyed and they can still be inspected) but
   they are never listed, never registered with the Gateway and
   never selectable for a binding or a job.

   ------------------------------------------------------------
   THE `unknown` POLICY
   ------------------------------------------------------------
   `unknown` means "no evidence either way": we could not attach
   the queue to a transport AND we found no proof that it is
   software. It is NOT treated as virtual.

   Automatic discovery does not promote `unknown` to a production
   printer, because a queue we cannot tie to any hardware is far
   more likely to be a leftover software queue than a printer.
   That decision is deliberate and conservative, and it is
   recoverable rather than destructive:

     * the record is never deleted — it is hidden but still on
       disk, and a future classifier can promote it;
     * explicit operator intent always wins. A device is surfaced
       despite being `unknown` when it came from

           registration_source = manual   (`printers add`)
           registration_source = config   (config.yaml)
           registration_source = registry (already persisted
                                           locally by this agent)

       so a printer an operator deliberately added, or one that a
       previous version already stored, does not silently vanish
       just because its Windows metadata is thin or unusual.

   Crucially this rescue applies ONLY to `unknown`. Virtual and
   redirected evidence is evaluated first and always rejects the
   device, so none of the above lets an operator bypass the
   safety check by registering "Microsoft Print to PDF" by hand,
   and a stale virtual row in the registry stays hidden.

   ------------------------------------------------------------
   ORDER OF AUTHORITY (virtual beats physical)
   ------------------------------------------------------------
   ClassifyDevice evaluates redirect evidence first, then virtual
   evidence, then physical evidence. Adding a permissive physical
   rule can therefore never un-hide a software queue that carries
   virtual evidence; it only stops real hardware from being
   dropped for want of metadata.

   Everything here is pure and platform independent, so the whole
   matrix is unit-testable on any OS.
   ============================================================ */

// PrinterClass is the high-level kind of a printing device.
type PrinterClass string

const (
	// ClassPhysical is real printing hardware we can send bytes to.
	ClassPhysical PrinterClass = "physical"
	// ClassVirtual is a software-only queue (file writer, fax, app target).
	ClassVirtual PrinterClass = "virtual"
	// ClassRedirected is a queue tunnelled from another session
	// (Remote Desktop, Citrix, VMware …) — not a local device.
	ClassRedirected PrinterClass = "redirected"
	// ClassUnknown is a queue we could not attach to any transport.
	ClassUnknown PrinterClass = "unknown"
)

// DeviceFacts is the normalized metadata classification is based on.
type DeviceFacts struct {
	Name        string
	DisplayName string
	DriverName  string
	PortName    string
	Comment     string
	Location    string
	ShareName   string

	ConnectionType string
	Protocol       string
	Endpoint       string
	SpoolerName    string
	NetworkAddress string
	Port           int

	USBVID    string
	USBPID    string
	USBSerial string

	DeviceID      string
	DeviceClass   string
	HardwareIDs   []string
	CompatibleIDs []string

	Capabilities map[string]interface{}
}

// DeviceClassification is the verdict for one device.
type DeviceClassification struct {
	Class        PrinterClass
	IsVirtual    bool   // true for virtual AND redirected queues
	IsRedirected bool   // true only for session-redirected queues
	Confidence   string // high | low | none
	Reasons      []string
}

// FactsFromDevice projects a DeviceInfo (plus its capability bag) onto the
// normalized metadata classification consumes.
func FactsFromDevice(d DeviceInfo) DeviceFacts {
	f := DeviceFacts{
		Name:           d.Name,
		DisplayName:    d.DisplayName,
		ConnectionType: d.ConnectionType,
		Protocol:       d.Protocol,
		Endpoint:       d.Endpoint,
		SpoolerName:    d.SpoolerName,
		NetworkAddress: d.NetworkAddress,
		Port:           d.Port,
		USBVID:         d.USBVID,
		USBPID:         d.USBPID,
		USBSerial:      d.USBSerial,
		Capabilities:   d.Capabilities,
	}
	if f.Name == "" {
		f.Name = d.DisplayName
	}
	if caps := d.Capabilities; caps != nil {
		f.DriverName = capString(caps, "driver_name")
		f.PortName = capString(caps, "port_name")
		f.Comment = capString(caps, "comment")
		f.Location = capString(caps, "location")
		f.ShareName = capString(caps, "share_name")
		f.DeviceID = capString(caps, "device_id")
		f.DeviceClass = capString(caps, "class")
		f.HardwareIDs = capStringSlice(caps, "hardware_ids")
		f.CompatibleIDs = capStringSlice(caps, "compatible_ids")
	}
	if f.SpoolerName == "" && spoolerToLowerTrim(f.ConnectionType) == "spooler" {
		f.SpoolerName = d.Endpoint
	}
	return f
}

// ClassifyDeviceInfo classifies a discovery/normalization-layer DeviceInfo.
func ClassifyDeviceInfo(d DeviceInfo) DeviceClassification {
	c := ClassifyDevice(FactsFromDevice(d))
	// An explicitly flagged record (persisted by this or an older version)
	// wins when the metadata alone is inconclusive.
	if d.IsVirtual && c.Class != ClassVirtual && c.Class != ClassRedirected {
		return DeviceClassification{
			Class:      ClassVirtual,
			IsVirtual:  true,
			Confidence: "high",
			Reasons:    []string{"device-flagged-virtual"},
		}
	}
	return c
}

// IsVirtualDevice reports whether the device is a software/redirected queue
// rather than printing hardware.
func IsVirtualDevice(d DeviceInfo) bool {
	return ClassifyDeviceInfo(d).IsVirtual
}

// IsProductionPrinter reports whether a device may be surfaced as a managed
// production printer: listed in the UI, registered with the Gateway and
// selectable for bindings and jobs.
func IsProductionPrinter(d DeviceInfo) bool {
	c := ClassifyDeviceInfo(d)
	switch c.Class {
	case ClassVirtual, ClassRedirected:
		return false
	case ClassPhysical:
		return true
	default:
		// Unclassified: only operator-intent registrations are surfaced.
		return IsExplicitlyRegistered(d)
	}
}

// IsExplicitlyRegistered reports whether this device reached us through an
// explicit operator action rather than through automatic discovery:
//
//	manual    — `printers add` / RegisterManual
//	config    — a printer declared in config.yaml
//	registry  — a record already persisted locally by this agent
//
// Such queues are trusted even when we cannot prove a transport.
//
// NOTE: this only ever rescues a device classified `unknown`. A device with
// virtual or redirected evidence is rejected before this is consulted, so an
// operator cannot bypass the safety check by registering "Microsoft Print to
// PDF" by hand, and a stale virtual row in the registry stays hidden.
func IsExplicitlyRegistered(d DeviceInfo) bool {
	if d.Capabilities == nil {
		return false
	}
	if b, ok := d.Capabilities["manual"].(bool); ok && b {
		return true
	}
	if v, ok := d.Capabilities["registration_source"].(string); ok {
		switch spoolerToLowerTrim(v) {
		case "manual", "config", "registry":
			return true
		}
	}
	return false
}

/* ---------- Evidence tables ---------- */

// virtualPortMonitors are Windows port monitors whose output never reaches
// hardware: they write a file, discard the job or hand it to another app.
var virtualPortMonitors = []string{
	"portprompt:", // Microsoft Print to PDF, "print to file" prompt
	"xpsport:",    // Microsoft XPS Document Writer
	"file:",       // print to file
	"nul:",        // discard
	"null:",
	"shrfax:", // Windows Shared Fax
	"fax:",
}

// softwareWriterTokens mark driver/PnP/name families that only ever produce
// a file or hand the job to an application. Every entry is matched against
// the driver name, the device instance id, the hardware/compatible ids and
// the printer name.
var softwareWriterTokens = []string{
	// ---- Microsoft in-box software writers ----
	"microsoft print to pdf",
	"microsoft xps document writer",
	"microsoft shared fax",
	"microsoft enhanced point and print compatibility driver",
	"send to onenote",
	"onenote",
	// ---- Semantic families (language independent) ----
	"document writer",
	"documentwriter",
	"print to pdf",
	"topdf",
	"pdf writer",
	"pdfwriter",
	"pdf printer",
	"pdf creator",
	"pdf converter",
	"pdf architect",
	"virtual printer",
	"software printer",
	"image printer",
	// ---- Widely deployed third-party software writers ----
	"foxit",
	"anydesk",
	"cutepdf",
	"pdf995",
	"novapdf",
	"bullzip",
	"pdfcreator",
	"pdfforge",
	"doro pdf",
	"biopdf",
	"nitro pdf",
	"adobe pdf",
	"bluebeam",
	"tinypdf",
	"7-pdf",
	"icecream pdf",
	"pdf24",
}

// sessionRedirectTokens identify queues tunnelled from another session.
var sessionRedirectTokens = []string{
	"remote desktop easy print",
	"terminal services easy print",
	"ts easy print",
	"easy print",
	"citrix",
	"vmware virtual print",
	"thinprint",
	"safeguard print",
}

/* ---------- Classifier ---------- */

// ClassifyDevice is the single entry point: metadata in, verdict out.
func ClassifyDevice(f DeviceFacts) DeviceClassification {
	if reason, ok := redirectedEvidence(f); ok {
		return DeviceClassification{
			Class:        ClassRedirected,
			IsVirtual:    true,
			IsRedirected: true,
			Confidence:   "high",
			Reasons:      []string{reason},
		}
	}
	if reasons := virtualEvidence(f); len(reasons) > 0 {
		return DeviceClassification{
			Class:      ClassVirtual,
			IsVirtual:  true,
			Confidence: "high",
			Reasons:    reasons,
		}
	}
	if ok, reason, confidence := physicalEvidence(f); ok {
		return DeviceClassification{
			Class:      ClassPhysical,
			Confidence: confidence,
			Reasons:    []string{reason},
		}
	}
	return DeviceClassification{
		Class:      ClassUnknown,
		Confidence: "none",
		Reasons:    []string{"no-transport-evidence"},
	}
}

// redirectedEvidence looks for Remote Desktop / Citrix / VMware tunnels.
func redirectedEvidence(f DeviceFacts) (string, bool) {
	name := spoolerToLowerTrim(f.Name)
	// Windows names RDP-redirected queues "HP LaserJet (redirected 3)";
	// Citrix uses "… (from WKS12) in session 4".
	inSession := strings.Contains(name, "in session")
	if strings.Contains(name, "(redirected") ||
		strings.HasSuffix(name, "redirected)") ||
		strings.Contains(name, " in session ") ||
		(strings.Contains(name, "(from ") && inSession) {
		return "redirected-printer-name", true
	}
	// Terminal Services port monitors are named TS001, TS002 …
	port := portHead(f.PortName)
	if len(port) > 2 && port[0] == 't' && port[1] == 's' && allDigits(port[2:]) {
		return "terminal-services-port", true
	}
	if hay := identityHaystack(f); hay != "" {
		for _, t := range sessionRedirectTokens {
			if strings.Contains(hay, t) {
				return "session-virtual-driver:" + t, true
			}
		}
	}
	return "", false
}

// virtualEvidence collects decisive proof that a queue is software-only.
func virtualEvidence(f DeviceFacts) []string {
	var reasons []string
	if _, isVirtualPort := portKind(f.PortName); isVirtualPort {
		reasons = append(reasons, "virtual-port-monitor:"+portHead(f.PortName))
	}
	hay := identityHaystack(f)
	for _, t := range softwareWriterTokens {
		if strings.Contains(hay, t) {
			reasons = append(reasons, "software-writer-driver:"+t)
		}
	}
	name := spoolerToLowerTrim(f.Name)
	if name != "" {
		for _, t := range softwareWriterTokens {
			if strings.Contains(name, t) {
				reasons = append(reasons, "software-writer-name:"+t)
			}
		}
	}
	return reasons
}

// physicalEvidence looks for proof that real hardware is attached.
func physicalEvidence(f DeviceFacts) (bool, string, string) {
	if strings.TrimSpace(f.USBVID) != "" || strings.TrimSpace(f.USBSerial) != "" {
		return true, "usb-identifiers", "high"
	}
	if isPrinterUSBDevice(f.HardwareIDs, f.CompatibleIDs, f.DeviceClass) {
		return true, "usb-print-class", "high"
	}
	// A USB device path is proof that Plug and Play enumerated real hardware,
	// even when the vendor's ids do not advertise the print class and no
	// VID/PID/serial could be parsed from the instance id.
	conn := spoolerToLowerTrim(f.ConnectionType)
	if conn == "usb" && strings.TrimSpace(f.Endpoint) != "" {
		return true, "usb-device-path", "high"
	}
	if strings.TrimSpace(f.NetworkAddress) != "" && f.Port != 0 {
		return true, "network-endpoint", "high"
	}
	proto := spoolerToLowerTrim(f.Protocol)
	if (conn == "ipp" || conn == "ipps" || proto == "ipp" || proto == "ipps") &&
		strings.TrimSpace(f.Endpoint) != "" {
		return true, "ipp-endpoint", "high"
	}
	if (conn == "network" || conn == "tcp") && strings.TrimSpace(f.NetworkAddress) != "" {
		return true, "network-endpoint", "high"
	}
	switch kind, _ := portKind(f.PortName); kind {
	case "usb", "wsd", "local", "network":
		return true, "hardware-port:" + kind, "high"
	case "other":
		// A named-but-unrecognised port that is not a software output port is
		// a vendor port monitor (Brother BRN_*, Canon BJNP_*, Samsung,
		// Kyocera …) — those drive real devices, so keep them visible rather
		// than hiding a working printer.
		return true, "vendor-port-monitor", "low"
	}
	// A named Windows print queue with no contradicting metadata is real: the
	// operator (or config.yaml) pointed at it deliberately. It is low
	// confidence because we cannot see the transport, so a queue we cannot tie
	// to a spooler name, a port or any endpoint stays unclassified.
	if strings.TrimSpace(f.SpoolerName) != "" {
		return true, "named-spooler-queue", "low"
	}
	return false, "", "none"
}

// identityHaystack is everything identifying the device, lowercased, so a
// single substring scan covers driver, PnP ids and comment.
func identityHaystack(f DeviceFacts) string {
	parts := make([]string, 0, 6)
	parts = append(parts, f.DriverName, f.DeviceID, f.Comment)
	parts = append(parts, f.HardwareIDs...)
	parts = append(parts, f.CompatibleIDs...)
	return spoolerToLowerTrim(strings.Join(parts, " "))
}

// portHead returns the significant part of a Windows port name: lowercased,
// trimmed and cut at the first comma ("IP_192.168.1.50,SNMP" → "ip_192.168.1.50").
func portHead(port string) string {
	if i := spoolerIndexComma(port); i >= 0 {
		port = port[:i]
	}
	return spoolerToLowerTrim(port)
}

// portKind classifies a Windows port monitor.
func portKind(port string) (kind string, isVirtual bool) {
	p := portHead(port)
	if p == "" {
		return "none", false
	}
	for _, v := range virtualPortMonitors {
		if p == v || spoolerHasPrefix(p, v) {
			return "virtual", true
		}
	}
	switch {
	case spoolerHasPrefix(p, "usb"), spoolerHasPrefix(p, "dot4"):
		return "usb", false
	case spoolerHasPrefix(p, "wsd"):
		return "wsd", false
	case spoolerHasPrefix(p, "lpt"), spoolerHasPrefix(p, "com"):
		return "local", false
	case spoolerHasPrefix(p, "ip_"):
		return "network", false
	}
	if _, _, err := spoolerSplitPort(p); err == nil {
		return "network", false
	}
	if isIPLikePort(p) {
		return "network", false
	}
	return "other", false
}

// isIPLikePort recognises raw IP ports and the Standard TCP/IP monitor's
// "<ip>_<snmp index>" form.
func isIPLikePort(p string) bool {
	if spoolerIsIPLike(p) {
		return true
	}
	if i := strings.LastIndex(p, "_"); i > 0 {
		return spoolerIsIPLike(p[:i])
	}
	return false
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

/* ---------- Capability helpers ---------- */

func capString(caps map[string]interface{}, key string) string {
	v, ok := caps[key]
	if !ok || v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

func capStringSlice(caps map[string]interface{}, key string) []string {
	v, ok := caps[key]
	if !ok || v == nil {
		return nil
	}
	switch vv := v.(type) {
	case []string:
		return vv
	case []interface{}:
		out := make([]string, 0, len(vv))
		for _, x := range vv {
			out = append(out, fmt.Sprint(x))
		}
		return out
	}
	return nil
}
