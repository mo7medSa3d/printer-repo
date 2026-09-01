package printer

import (
	"encoding/json"
	"fmt"
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

// loadRegistryPrinters reads the registry file and returns DeviceInfos.
// It filters out stale generic PnP entries that were persisted by old buggy
// discovery (USB Input Device, etc.) and rewrites the file to clean it.
// If file does not exist, returns nil slice (not error).
func loadRegistryPrinters(registryPath string) ([]DeviceInfo, error) {
	if registryPath == "" {
		return nil, nil
	}
	data, err := os.ReadFile(registryPath)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, nil
	}
	var infos []DeviceInfo
	if err := json.Unmarshal(data, &infos); err != nil {
		return nil, fmt.Errorf("parse registry %s: %w", registryPath, err)
	}
	// Filter out stale generic devices that are not valid printers.
	filtered := make([]DeviceInfo, 0, len(infos))
	removed := 0
	for _, d := range infos {
		if !isValidDiscoveredPrinter(d) {
			removed++
			continue
		}
		filtered = append(filtered, d)
	}
	if removed > 0 {
		// Rewrite cleaned registry asynchronously - best effort, not fatal
		_ = SaveRegistry(registryPath, filtered)
	}
	return filtered, nil
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
	existing, err := loadRegistryPrinters(registryPath)
	if err != nil && !os.IsNotExist(err) {
		existing = nil
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
		if idx, ok := byID[d.ID]; ok {
			// Update existing
			existing[idx] = d
		} else {
			existing = append(existing, d)
			byID[d.ID] = len(existing) - 1
		}
	}
	if err := SaveRegistry(registryPath, existing); err != nil {
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
	return UpsertRegistry(registryPath, []DeviceInfo{info})
}

// RemoveFromRegistry removes a printer by ID.
func RemoveFromRegistry(registryPath, printerID string) error {
	existing, err := loadRegistryPrinters(registryPath)
	if err != nil {
		return err
	}
	out := make([]DeviceInfo, 0, len(existing))
	for _, p := range existing {
		if p.ID != printerID {
			out = append(out, p)
		}
	}
	return SaveRegistry(registryPath, out)
}
