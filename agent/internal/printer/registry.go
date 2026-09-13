package printer

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/odoo-print-agent/agent/internal/config"
	"sync"
	"time"
)

// registryMu serializes every read-modify-write of printers.json within this
// process. Async discovery, on-demand discovery, manual registration and the
// CLI helpers all mutate the file concurrently; without one authority, two
// overlapping saves interleave into a truncated registry or a lost update —
// and a lost update that later parses as valid JSON deletes working hardware.
var registryMu sync.Mutex

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
// LoadRegistryPrinters exports loadRegistryPrinters for external callers.
func LoadRegistryPrinters(registryPath string) ([]DeviceInfo, error) {
	return loadRegistryPrinters(registryPath)
}

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
	registryMu.Lock()
	defer registryMu.Unlock()
	return loadRegistryPartitionedLocked(registryPath)
}

func loadRegistryPartitionedLocked(registryPath string) (production, hidden []DeviceInfo, removed int, err error) {
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
		_ = saveRegistryLocked(registryPath, concatDevices(production, hidden))
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

// Save persists the given DeviceInfos atomically to the registry path under
// the process-wide registry lock, with a unique temp name (two concurrent
// saves sharing one ".tmp" path can interleave) and 0600 file mode (the
// registry describes locally attached hardware endpoints).
func SaveRegistry(registryPath string, printers []DeviceInfo) error {
	registryMu.Lock()
	defer registryMu.Unlock()
	return saveRegistryLocked(registryPath, printers)
}

func saveRegistryLocked(registryPath string, printers []DeviceInfo) error {
	if registryPath == "" {
		return fmt.Errorf("registry path empty")
	}
	dir := filepath.Dir(registryPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := config.EnsureSecureDirectoryACL(dir); err != nil {
		return fmt.Errorf("secure registry dir: %w", err)
	}
	data, err := json.MarshalIndent(printers, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".printers-*.json")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if err := tmp.Chmod(0600); err != nil {
		log.Printf("[registry] could not restrict permissions on %s: %v", tmpName, err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := config.EnsureSecureFileACL(tmpName); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("secure registry temp file: %w", err)
	}
	if err := os.Rename(tmpName, registryPath); err != nil {
		return err
	}
	if err := config.EnsureSecureFileACL(registryPath); err != nil {
		return fmt.Errorf("secure registry file: %w", err)
	}
	return nil
}

// Upsert merges discovered printers into the registry idempotently:
//   - If ID already exists, update the record.
//   - Otherwise append.
//
// Returns the merged slice.
func UpsertRegistry(registryPath string, discovered []DeviceInfo) ([]DeviceInfo, error) {
	registryMu.Lock()
	defer registryMu.Unlock()
	existing, hidden, _, err := loadRegistryPartitionedLocked(registryPath)
	if err != nil {
		if os.IsNotExist(err) {
			existing, hidden = nil, nil
		} else {
			// A corrupt registry must never be silently replaced by an empty
			// one: quarantine the file first so the data is recoverable.
			quarantine := fmt.Sprintf("%s.corrupt-%d", registryPath, time.Now().Unix())
			if rerr := os.Rename(registryPath, quarantine); rerr == nil {
				log.Printf("[registry] WARNING: %s failed to parse; the damaged file was preserved at %s", registryPath, quarantine)
			} else {
				log.Printf("[registry] WARNING: could not quarantine damaged registry: %v", rerr)
			}
			existing, hidden = nil, nil
		}
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
	if err := saveRegistryLocked(registryPath, all); err != nil {
		return nil, err
	}
	return existing, nil
}

// RegisterManual adds or updates a manually configured printer.
// Manual registration is the operator's EXPLICIT statement of intent, so it
// must never be repaired with invented values: network and USB devices
// require an explicit protocol; only transports with their own identity
// (spooler queues, IPP URLs) may derive it.
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
		switch info.ConnectionType {
		case "spooler", "windows_spooler":
			info.Protocol = "spooler"
		case "ipp", "ipps":
			info.Protocol = info.ConnectionType
		default:
			return nil, fmt.Errorf("printer %q: --protocol is required for %s printers (raw, escpos, zpl, tspl); no default is guessed", info.ID, info.ConnectionType)
		}
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
	registryMu.Lock()
	defer registryMu.Unlock()
	existing, hidden, _, err := loadRegistryPartitionedLocked(registryPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	out := make([]DeviceInfo, 0, len(existing))
	for _, p := range existing {
		if p.ID != printerID {
			out = append(out, p)
		}
	}
	// Hidden records survive an unrelated removal.
	return saveRegistryLocked(registryPath, concatDevices(out, hidden))
}
