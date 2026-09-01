package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"

	"github.com/odoo-print-agent/agent/internal/agent"
	"github.com/odoo-print-agent/agent/internal/config"
	"github.com/odoo-print-agent/agent/internal/printer"
)

func main() {
	serverURL := flag.String("server", "", "Server URL (required for -pair), e.g. https://gateway.example.com")
	pairingCode := flag.String("pair", "", "Pairing code from dashboard")
	configPath := flag.String("config", config.DefaultConfigPath(), "Path to config file")
	// Printer subcommands also support --json flag via manual parsing
	flag.Parse()

	// If subcommand style "printers ..." is used, handle before pairing check
	args := flag.Args()
	if len(args) > 0 {
		// Check for printers subcommand
		if args[0] == "printers" {
			handlePrintersSubcommand(args[1:], *configPath)
			return
		}
		// Also support legacy flag style: -pair etc already handled, so unknown args => usage
		fmt.Printf("Unknown command: %v\n", args)
		printUsage()
		os.Exit(1)
	}

	if *pairingCode != "" {
		if strings.TrimSpace(*serverURL) == "" {
			log.Fatal("-server is required when pairing (e.g. -server https://gateway.example.com)")
		}
		if err := validateServerURL(*serverURL); err != nil {
			log.Fatalf("Invalid -server: %v", err)
		}
		if strings.TrimSpace(*pairingCode) == "" {
			log.Fatal("-pair requires a non-empty pairing code")
		}
		effectiveConfigPath := *configPath
		if err := config.Ensure(effectiveConfigPath); err != nil {
			if *configPath == config.DefaultConfigPath() {
				local := config.LocalConfigPath()
				if localErr := config.Ensure(local); localErr == nil {
					log.Printf("WARNING: default config path not writable (%v); using per-user fallback %s", err, local)
					effectiveConfigPath = local
				} else {
					log.Fatalf("Failed to prepare config: %v", err)
				}
			} else {
				log.Fatalf("Failed to prepare config: %v", err)
			}
		}
		*configPath = effectiveConfigPath
		err := agent.Register(*serverURL, strings.ToUpper(strings.TrimSpace(*pairingCode)), *configPath)
		if err != nil {
			log.Fatalf("Pairing failed: %v", err)
		}
		os.Exit(0)
	}

	printUsage()
}

func printUsage() {
	fmt.Println("Odoo Print Agent CLI")
	fmt.Println("")
	fmt.Println("Pairing (one-time):")
	fmt.Println("  odoo-agent-cli.exe -pair <code> -server <url> [-config <path>]")
	fmt.Println("  -server is required for pairing and must be http(s).")
	fmt.Println("  Default config path:", config.DefaultConfigPath())
	fmt.Println("")
	fmt.Println("Printer management:")
	fmt.Println("  odoo-agent-cli.exe printers list [--json] [-config <path>]")
	fmt.Println("  odoo-agent-cli.exe printers discover [--json] [-config <path>]")
	fmt.Println("  odoo-agent-cli.exe printers test <printer-id> [-config <path>]")
	fmt.Println("  odoo-agent-cli.exe printers add --name <name> --type <network|usb|spooler|ipp> --endpoint <ip:port|spooler_name> [--protocol raw|escpos|ipp|spooler] [--spooler-name <name>] [--id <id>] [-config <path>]")
	fmt.Println("    Optional: --printer-type <thermal|laser|inkjet|label|unknown> --vid <hex> --pid <hex> --serial <serial> --enabled <true|false> --capabilities <json>")
	fmt.Println("  odoo-agent-cli.exe printers remove <printer-id> [-config <path>]")
	fmt.Println("")
	fmt.Println("Discovery output fields: id, name, type, connectionType, protocol, endpoint, spoolerName, status, enabled, networkAddress, port, usbVid, usbPid, usbSerial, driver, portName, capabilities")
	fmt.Println("Examples:")
	fmt.Println("  printers add --name \"Kitchen\" --type network --endpoint 192.168.1.50:9100 --protocol escpos")
	fmt.Println("  printers add --name \"HP LaserJet\" --type spooler --spooler-name \"HP LaserJet\"")
	fmt.Println("  printers add --name \"Label USB\" --type usb --vid 03f0 --pid 0c17 --serial CN123 --spooler-name \"Zebra\"")
}

func validateServerURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return fmt.Errorf("parse url: %w", err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return fmt.Errorf("scheme must be https or http")
	}
	if u.Host == "" {
		return fmt.Errorf("host is required")
	}
	return nil
}

func handlePrintersSubcommand(args []string, defaultConfigPath string) {
	if len(args) == 0 {
		fmt.Println("Usage: printers <list|discover|test|add|remove> ...")
		os.Exit(1)
	}
	cmd := args[0]
	rest := args[1:]

	// Parse --config and --json from rest
	configPath := defaultConfigPath
	jsonOutput := false
	filtered := []string{}
	for i := 0; i < len(rest); i++ {
		switch rest[i] {
		case "-config", "--config":
			if i+1 < len(rest) {
				configPath = rest[i+1]
				i++
			}
		case "--json", "-json":
			jsonOutput = true
		default:
			// For 'test' and 'remove', the printer ID is positional
			// For 'add', we keep all flags
			filtered = append(filtered, rest[i])
		}
	}

	switch cmd {
	case "list":
		handlePrintersList(configPath, jsonOutput)
	case "discover":
		handlePrintersDiscover(configPath, jsonOutput)
	case "test":
		if len(filtered) == 0 {
			log.Fatal("printers test requires <printer-id>")
		}
		handlePrintersTest(configPath, filtered[0])
	case "add":
		handlePrintersAdd(configPath, filtered)
	case "remove":
		if len(filtered) == 0 {
			log.Fatal("printers remove requires <printer-id>")
		}
		handlePrintersRemove(configPath, filtered[0])
	default:
		fmt.Printf("Unknown printers command: %s\n", cmd)
		fmt.Println("Available: list, discover, test, add, remove")
		os.Exit(1)
	}
}

func loadConfigForCLI(configPath string) *struct {
	cfg *config.Config
	path string
} {
	// Ensure registry dir exists
	_ = config.Ensure(configPath)
	cfg, err := config.Load(configPath)
	if err != nil {
		log.Fatalf("Failed to load config %s: %v", configPath, err)
	}
	return &struct {
		cfg *config.Config
		path string
	}{cfg: cfg, path: configPath}
}

func handlePrintersList(configPath string, jsonOutput bool) {
	loaded := loadConfigForCLI(configPath)
	registryPath := config.RegistryPath(loaded.path)
	infos, err := printer.ListPrinters(loaded.cfg, registryPath)
	if err != nil {
		log.Fatalf("List failed: %v", err)
	}
	if jsonOutput {
		out, _ := json.Marshal(infos)
		fmt.Println(string(out))
		return
	}
	if len(infos) == 0 {
		fmt.Println("No printers discovered. Run 'printers discover' or 'printers add'.")
		fmt.Println("Note: YAML printers: [] is not required; discovery and manual registration are the production paths.")
		return
	}
	fmt.Printf("%-32s %-24s %-12s %-10s %-8s %-7s %s\n", "ID", "NAME", "TYPE", "PROTO", "STATUS", "ENABLED", "ENDPOINT/SPOOLER")
	fmt.Println("--------------------------------------------------------------------------------------------------------------------------------")
	for _, d := range infos {
		endpoint := d.Endpoint
		if d.SpoolerName != "" {
			endpoint = d.SpoolerName
		}
		if endpoint == "" && d.NetworkAddress != "" {
			if d.Port != 0 {
				endpoint = fmt.Sprintf("%s:%d", d.NetworkAddress, d.Port)
			} else {
				endpoint = d.NetworkAddress
			}
		}
		enabledStr := "true"
		if !d.Enabled {
			enabledStr = "false"
		}
		fmt.Printf("%-32s %-24s %-12s %-10s %-8s %-7s %s\n", d.ID, d.Name, d.ConnectionType, d.Protocol, d.Status, enabledStr, endpoint)
	}
}

func handlePrintersDiscover(configPath string, jsonOutput bool) {
	loaded := loadConfigForCLI(configPath)
	registryPath := config.RegistryPath(loaded.path)
	printers := discoverHelper(loaded.cfg, registryPath, jsonOutput)
	if jsonOutput {
		out, err := json.Marshal(printers)
		if err != nil {
			log.Fatalf("failed to encode discovery result: %v", err)
		}
		fmt.Println(string(out))
		return
	}
	fmt.Printf("Discovery completed: %d printers found\n", len(printers))
	for _, d := range printers {
		fmt.Printf("  - %s\n", d.ID)
	}
	if len(printers) == 0 {
		fmt.Println("No printers discovered. Try manual registration:")
		fmt.Println("  odoo-agent-cli.exe printers add --name \"My Printer\" --type spooler --spooler-name \"HP LaserJet\"")
	}
}

func handlePrintersTest(configPath, printerID string) {
	loaded := loadConfigForCLI(configPath)
	registryPath := config.RegistryPath(loaded.path)
	fmt.Printf("Testing printer %s...\n", printerID)
	if err := testPrinterHelper(loaded.cfg, registryPath, printerID); err != nil {
		log.Fatalf("Test print FAILED for %s: %v", printerID, err)
	}
	fmt.Printf("Test print succeeded for %s (bytes submitted to spooler/TCP).\n", printerID)
}

func handlePrintersAdd(configPath string, args []string) {
	loaded := loadConfigForCLI(configPath)
	registryPath := config.RegistryPath(loaded.path)
	fs := flag.NewFlagSet("printers add", flag.ExitOnError)
	name := fs.String("name", "", "Printer display name")
	id := fs.String("id", "", "Stable printer ID (optional, auto-generated)")
	typ := fs.String("type", "network", "Connection type: network/tcp/usb/spooler/ipp")
	endpoint := fs.String("endpoint", "", "Endpoint: ip:port for network, spooler name for spooler, usb path for usb")
	protocol := fs.String("protocol", "raw", "Protocol: raw/escpos/ipp/spooler")
	spoolerName := fs.String("spooler-name", "", "Windows spooler name (for spooler type)")
	printerType := fs.String("printer-type", "unknown", "Printer type: thermal/laser/inkjet/label/unknown")
	vid := fs.String("vid", "", "USB VID hex (e.g., 03f0)")
	pid := fs.String("pid", "", "USB PID hex (e.g., 0c17)")
	serial := fs.String("serial", "", "USB serial number")
	enabledStr := fs.String("enabled", "true", "Enabled true/false")
	capsJSON := fs.String("capabilities", "", "Capabilities JSON e.g., '{\"paper_widths\":[58,80]}'")
	_ = fs.String("connection-type", "", "Alias for --type")
	fs.Parse(args)

	for i := 0; i < len(args); i++ {
		if args[i] == "--connection-type" && i+1 < len(args) {
			*typ = args[i+1]
		}
	}
	if strings.TrimSpace(*name) == "" {
		log.Fatal("--name is required for printers add")
	}
	if strings.TrimSpace(*endpoint) == "" && strings.TrimSpace(*spoolerName) == "" && strings.TrimSpace(*vid) == "" {
		if strings.ToLower(*typ) == "spooler" && *spoolerName != "" {
			*endpoint = *spoolerName
		} else {
			log.Fatal("--endpoint or --spooler-name is required (or --vid for USB)")
		}
	}
	effectiveEndpoint := *endpoint
	if *spoolerName != "" && effectiveEndpoint == "" {
		effectiveEndpoint = *spoolerName
	}
	if effectiveEndpoint == "" && *vid != "" {
		effectiveEndpoint = fmt.Sprintf("usb-vid:%s pid:%s", *vid, *pid)
	}
	enabled := strings.ToLower(strings.TrimSpace(*enabledStr)) != "false"
	var caps map[string]interface{}
	if *capsJSON != "" {
		// Parse JSON capabilities
		// Use simple JSON parse via addPrinterHelper
		caps = map[string]interface{}{"_raw": *capsJSON}
	}

	info := struct {
		ID             string
		Name           string
		ConnectionType string
		PrinterType    string
		Endpoint       string
		Protocol       string
		SpoolerName    string
		USBVID         string
		USBPID         string
		USBSerial      string
		Enabled        bool
		Capabilities   map[string]interface{}
	}{ID: *id, Name: *name, ConnectionType: *typ, PrinterType: *printerType, Endpoint: effectiveEndpoint, Protocol: *protocol, SpoolerName: *spoolerName, USBVID: *vid, USBPID: *pid, USBSerial: *serial, Enabled: enabled, Capabilities: caps}
	// Handle capabilities JSON raw
	if *capsJSON != "" && caps["_raw"] != nil {
		// Try to parse as JSON
		var parsed map[string]interface{}
		if err := parseCapabilitiesJSON(*capsJSON, &parsed); err == nil {
			info.Capabilities = parsed
		} else {
			log.Printf("WARNING: invalid capabilities JSON: %v", err)
			info.Capabilities = caps
		}
	}

	if err := addPrinterHelper(loaded.cfg, registryPath, info); err != nil {
		log.Fatalf("Failed to add printer: %v", err)
	}
	fmt.Printf("Printer registered: %s (%s) type=%s conn=%s enabled=%v\n", info.Name, info.ID, info.PrinterType, info.ConnectionType, info.Enabled)
	if info.ID == "" {
		fmt.Println("ID auto-generated deterministically; discover will not duplicate it.")
	}
	if strings.ToLower(info.ConnectionType) == "usb" && info.SpoolerName == "" {
		fmt.Println("NOTE: USB without spooler queue will be discovered but printing requires Windows spooler queue. Install via Windows Settings > Printers and re-add with --spooler-name.")
	}
	_ = registryPath
}

func handlePrintersRemove(configPath, printerID string) {
	loaded := loadConfigForCLI(configPath)
	registryPath := config.RegistryPath(loaded.path)
	if err := removePrinterHelper(registryPath, printerID); err != nil {
		log.Fatalf("Failed to remove printer %q: %v", printerID, err)
	}
	fmt.Printf("Printer %q removed from registry.\n", printerID)
}

func parseCapabilitiesJSON(s string, out *map[string]interface{}) error {
	return json.Unmarshal([]byte(s), out)
}
