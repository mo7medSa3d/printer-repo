package printer

import "strings"

// Canonical cross-layer payload/protocol compatibility table.
//
// This mirrors src/lib/routing.ts (gateway) EXACTLY; both sides enforce the
// same explicit model:
//
//   - type=escpos            -> device must declare escpos
//   - type=raw + protocol=X  -> device must declare X, X in
//                                {raw, escpos, zpl, tspl}; there is NO
//                               wildcard: "raw" is a byte sink, not "any
//                               protocol compatible"
//   - type=pdf               -> spooler/ipp document transports (or an
//                               explicit capability)
//   - type=image             -> driver-backed transports or an ESC/POS
//                               device that raster-converts
//   - peripherals            -> escpos only (enforced in payload.Parse)
//
// An explicit supported_protocols capability list is authoritative; without
// one, the device's declared transport protocol decides.
//
// AUTHORITATIVE RULE for "unknown" protocol (mirrored in
// src/lib/routing.ts): "unknown" means "no byte language declared". The
// connection type is itself an explicit TRANSPORT declaration for transports
// that are physically complete (a Windows spooler queue renders documents;
// an IPP URL accepts document formats), so unknown+spooler/ipp behaves as
// that transport. For network/usb (byte pipes with no declared language)
// the family resolves to a name nothing matches: the device is inventoried
// but dark until its protocol is declared.

// DeviceFacts are the declared transport properties of one printer entry.
type TransportFacts struct {
	Protocol          string
	Connection        string
	SupportedProtocol []string
}

// PayloadCompatibleForDevice reports whether the payload may physically be
// printed on the device, and returns a reason when it may not.
func PayloadCompatibleForDevice(plType, plProtocol string, d TransportFacts) (bool, string) {
	pt := strings.ToLower(strings.TrimSpace(plType))
	pp := strings.ToLower(strings.TrimSpace(plProtocol))
	proto := strings.ToLower(strings.TrimSpace(d.Protocol))
	conn := strings.ToLower(strings.TrimSpace(d.Connection))
	family := proto
	if family == "" || family == "unknown" {
		family = conn
	}
	hasCaps := len(d.SupportedProtocol) > 0

	capabilityListed := func(names ...string) bool {
		for _, name := range names {
			for _, c := range d.SupportedProtocol {
				if strings.EqualFold(c, name) {
					return true
				}
			}
		}
		return false
	}
	transportIs := func(names ...string) bool {
		for _, name := range names {
			if family == name {
				return true
			}
		}
		return false
	}
	declared := func(name string, transports ...string) bool {
		if hasCaps {
			return capabilityListed(name)
		}
		return transportIs(transports...)
	}

	switch pt {
	case "pdf":
		if pp != "" {
			return false, "pdf payloads cannot specify a printer protocol"
		}
		if hasCaps && capabilityListed("pdf", "spooler", "ipp", "ipps") {
			return true, ""
		}
		if !hasCaps && transportIs("spooler", "ipp", "ipps") {
			return true, ""
		}
		return false, "pdf requires spooler or IPP transport"
	case "image":
		if pp != "" {
			return false, "image payloads cannot specify a printer protocol"
		}
		if hasCaps && capabilityListed("image", "jpeg", "spooler", "ipp", "ipps", "escpos") {
			return true, ""
		}
		if !hasCaps && (transportIs("spooler") || declared("escpos", "escpos")) {
			return true, ""
		}
		return false, "image payload not supported by printer"
	case "escpos":
		if pp != "" && pp != "escpos" {
			return false, "escpos payload cannot use protocol " + pp
		}
		if declared("escpos", "escpos") {
			return true, ""
		}
		return false, "printer does not explicitly support ESC/POS (protocol=" + familyOrUnknown(family) + ")"
	case "raw":
		if pp == "" {
			return false, "raw payloads must declare an explicit protocol (raw, escpos, zpl, or tspl)"
		}
		switch pp {
		case "raw", "escpos", "zpl", "tspl":
		default:
			return false, "unsupported raw protocol " + pp
		}
		if declared(pp, pp) {
			return true, ""
		}
		return false, "printer does not explicitly support " + strings.ToUpper(pp) + " (protocol=" + familyOrUnknown(family) + ")"
	}
	return false, "unsupported payload type " + pt
}

func familyOrUnknown(family string) string {
	if family == "" {
		return "unknown"
	}
	return family
}

// SupportedProtocolsForDevice derives the honest capability list for a
// device from its declared transport. It is only used when the operator has
// not configured an explicit list; the derived list never contains a
// protocol the device cannot physically consume.
func SupportedProtocolsForDevice(d TransportFacts) []string {
	family := strings.ToLower(strings.TrimSpace(d.Protocol))
	if family == "" || family == "unknown" {
		family = strings.ToLower(strings.TrimSpace(d.Connection))
	}
	switch family {
	case "escpos":
		return []string{"escpos", "image"}
	case "zpl":
		return []string{"zpl"}
	case "tspl":
		return []string{"tspl"}
	case "raw":
		return []string{"raw"}
	case "spooler":
		return []string{"pdf", "image"}
	case "ipp", "ipps":
		return []string{"pdf"}
	default:
		return []string{}
	}
}
