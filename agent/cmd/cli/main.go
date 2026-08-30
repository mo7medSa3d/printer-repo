package main

import (
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"

	"github.com/odoo-print-agent/agent/internal/agent"
	"github.com/odoo-print-agent/agent/internal/config"
)

func main() {
	serverURL := flag.String("server", "", "Server URL (required for -pair), e.g. https://gateway.example.com")
	pairingCode := flag.String("pair", "", "Pairing code from dashboard")
	configPath := flag.String("config", config.DefaultConfigPath(), "Path to config file")
	flag.Parse()

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
		// Create the writable runtime directory before the CLI saves credentials.
		// A non-elevated user may not be able to create ProgramData; fall back
		// to a per-user AppData path when pairing through the default config.
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

	fmt.Println("Odoo Print Agent CLI")
	fmt.Println("Usage: odoo-agent-cli.exe -pair <code> -server <url> [-config <path>]")
	fmt.Println("  -server is required for pairing and must be http(s).")
	fmt.Println("  Default config path:", config.DefaultConfigPath())
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
