package printer

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
)

// Registry is the on-disk persistence for discovered and manually registered
// printers. It is stored as JSON beside config.yaml (printers.json) and is
// the source of truth for stable IDs on this machine. Discovery is idempotent:
// repeated discoveries update existing records instead of creating duplicates.
type Registry struct {
	mu   sync.Mutex
	path string
}

// NewRegistry creates a registry handle for the given config path.
func NewRegistry(configPath string) *Registry {
	dir := filepath.Dir(configPath)
	if dir == "" || dir == "." {
		dir = "."
	}
	return &Registry{path: filepath.Join(dir, "printers.json")}
}

// loadRegistryPrinters reads the registry file and returns the printers that
// may be surfaced as managed production printers.
//
// Two categories are kept out of the returned slice:
//   - stale generic PnP entries persisted by old buggy discovery (USB Input
//     Device, HID mice, cameras …) — those are junk and get cleaned up;
//   - virtual / redirected / unclassified queues — those are PRESERVED on disk
//     (never deleted) but never listed, so an operator can still inspect what
//     this machine reports and a future classifier can recover them.
//
// If the file does not exist, a nil slice is returned (not an error).
func loadRegistryPrinters(registryPath string) ([]DeviceInfo, error) {
	production, _, _, err := loadRegistryPartitioned(registryPath)
	return production, err
}

// loadRegistryPartitioned splits the persisted registry into the printers that
// may be surfaced, the records that must be kept but hidden, and the number of
// junk entries that were dropped.
func loadRegistryPartitioned(registryPath string) (production, hidden []DeviceInfo, removed int, err error) {
	if registryPath == "" {
		return nil, nil, 0, nil
	}
	data, err := os.ReadFile(registryPath)
	if err != nil {
		return nil, nil, 0, err
	}
	if len(data) == 0 {
		return nil, nil, 0, nil
	}
	var infos []DeviceInfo
	if err := json.Unmarshal(data, &infos); err != nil {
		return nil, nil, 0, fmt.Errorf("parse registry %s: %w", registryPath, err)
	}
	production = make([]DeviceInfo, 0, len(infos))
	for _, d := range infos {
		if !isValidDiscoveredPrinter(d) {
			// Not a printer at all — drop the stale entry.
			removed++
			continue
		}
		// A record persisted by this agent (or an earlier version) is
		// deliberate operator state. Mark it so that a queue whose metadata is
		// simply too thin to classify is kept instead of silently dropping
		// working hardware. Virtual / redirected evidence still outranks this
		// — see IsProductionPrinter.
		d = withRegistrationSource(d, "registry")
		if !IsProductionPrinter(d) {
			hidden = append(hidden, d)
			continue
		}
		production = append(production, d)
	}
	if removed > 0 {
		// Rewrite the cleaned registry (best effort, not fatal). Hidden
		// records are written back so nothing is destroyed.
		_ = SaveRegistry(registryPath, concatDevices(production, hidden))
	}
	return production, hidden, removed, nil
}

// withRegistrationSource records where a device came from, without overwriting
// an existing (more specific) source such as "manual" or "config".
func withRegistrationSource(d DeviceInfo, source string) DeviceInfo {
	if d.Capabilities == nil {
		d.Capabilities = map[string]interface{}{}
	}
	if _, ok := d.Capabilities["registration_source"]; !ok {
		d.Capabilities["registration_source"] = source
	}
	return d
}

func concatDevices(a, b []DeviceInfo) []DeviceInfo {
	out := make([]DeviceInfo, 0, len(a)+len(b))
	out = append(out, a...)
	out = append(out, b...)
	return out
}

// Save persists the given DeviceInfos atomically to the registry path.
func SaveRegistry(registryPath string, printers []DeviceInfo) error {
	if registryPath == "" {
		return fmt.Errorf("registry path empty")
	}
	dir := filepath.Dir(registryPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(printers, "", "  ")
	if err != nil {
		return err
	}
	tmp := registryPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, registryPath)
}

// Upsert merges discovered printers into the registry idempotently:
// - If ID already exists, update the record.
// - Otherwise append.
// Returns the merged slice.
func UpsertRegistry(registryPath string, discovered []DeviceInfo) ([]DeviceInfo, error) {
	existing, hidden, _, err := loadRegistryPartitioned(registryPath)
	if err != nil && !os.IsNotExist(err) {
		existing = nil
		hidden = nil
	}
	byID := make(map[string]int)
	for i, p := range existing {
		if p.ID != "" {
			byID[p.ID] = i
		}
	}
	for _, d := range discovered {
		if d.ID == "" {
			d.ID = StableIDForDevice(d)
		}
		if !isValidDiscoveredPrinter(d) {
			continue
		}
		// A virtual, redirected or unclassified queue is never promoted into
		// the managed printer set, whatever source reported it.
		if !IsProductionPrinter(d) {
			log.Printf("[registry] refusing to register non-physical printer %q class=%s", d.Name, ClassifyDeviceInfo(d).Class)
			continue
		}
		if idx, ok := byID[d.ID]; ok {
			// Update existing
			existing[idx] = d
		} else {
			existing = append(existing, d)
			byID[d.ID] = len(existing) - 1
		}
	}
	// Persist hidden records too: hiding a queue must never delete it.
	all := concatDevices(existing, hidden)
	if err := SaveRegistry(registryPath, all); err != nil {
		return nil, err
	}
	return existing, nil
}

// RegisterManual adds or updates a manually configured printer.
// Manual registration must support tcp/usb/spooler/ipp as per spec.
// The caller's Enabled value is preserved (CLI --enabled false must not be
// silently overridden); callers that want the default must set it themselves
// (CLI defaults --enabled to true).
func RegisterManual(registryPath string, info DeviceInfo) ([]DeviceInfo, error) {
	if info.ID == "" {
		info.ID = StableIDForDevice(info)
	}
	if info.Status == "" {
		info.Status = "unknown"
	}
	if info.ConnectionType == "" {
		info.ConnectionType = "network"
	}
	if info.Protocol == "" {
		info.Protocol = "raw"
	}
	// Explicit operator intent: a manually registered queue stays visible even
	// when no transport can be proven from its metadata.
	if info.Capabilities == nil {
		info.Capabilities = map[string]interface{}{}
	}
	if _, ok := info.Capabilities["registration_source"]; !ok {
		info.Capabilities["registration_source"] = "manual"
	}
	return UpsertRegistry(registryPath, []DeviceInfo{info})
}

// RemoveFromRegistry removes a printer by ID.
func RemoveFromRegistry(registryPath, printerID string) error {
	existing, hidden, _, err := loadRegistryPartitioned(registryPath)
	if err != nil {
		return err
	}
	out := make([]DeviceInfo, 0, len(existing))
	for _, p := range existing {
		if p.ID != printerID {
			out = append(out, p)
		}
	}
	// Hidden records survive an unrelated removal.
	return SaveRegistry(registryPath, concatDevices(out, hidden))
}
