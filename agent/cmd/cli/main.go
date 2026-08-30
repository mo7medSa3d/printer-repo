package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/odoo-print-agent/agent/internal/agent"
	"github.com/odoo-print-agent/agent/internal/config"
)

func main() {
	serverURL := flag.String("server", "http://localhost:3000", "Server URL")
	pairingCode := flag.String("pair", "", "Pairing code from dashboard")
	configPath := flag.String("config", config.DefaultConfigPath(), "Path to config file")
	flag.Parse()

	if *pairingCode != "" {
		err := agent.Register(*serverURL, *pairingCode, *configPath)
		if err != nil {
			log.Fatalf("Pairing failed: %v", err)
		}
		os.Exit(0)
	}

	fmt.Println("Odoo Print Agent CLI")
	fmt.Println("Use -pair <code> -server <url> to register this agent.")
}
