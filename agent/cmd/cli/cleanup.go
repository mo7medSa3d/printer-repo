package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/odoo-print-agent/agent/internal/config"
	"github.com/odoo-print-agent/agent/internal/queue"
)

// init handles the maintenance-only `jobs cleanup` command before the legacy
// flag-based CLI parser runs. The existing CLI binary is already bundled with
// the Desktop Manager, so cleanup does not require shipping another binary.
func init() {
	if len(os.Args) < 3 || os.Args[1] != "jobs" || os.Args[2] != "cleanup" {
		return
	}

	configPath := config.DefaultConfigPath()
	jsonOutput := false
	for i := 3; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--json", "-json":
			jsonOutput = true
		case "--config", "-config":
			if i+1 >= len(os.Args) || os.Args[i+1] == "" {
				fatalCleanup("--config requires a path")
			}
			configPath = os.Args[i+1]
			i++
		}
	}

	deleted, err := queue.CleanupTerminalJobs(config.QueueDBPath(configPath))
	if err != nil {
		fatalCleanup(fmt.Sprintf("cleanup failed: %v", err))
	}

	if jsonOutput {
		payload, err := json.Marshal(struct {
			Deleted int `json:"deleted"`
		}{Deleted: deleted})
		if err != nil {
			fatalCleanup(fmt.Sprintf("encode cleanup result: %v", err))
		}
		fmt.Println(string(payload))
	} else {
		fmt.Printf("Removed %d terminal local print jobs.\n", deleted)
	}
	os.Exit(0)
}

func fatalCleanup(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
