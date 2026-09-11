package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

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
	includeUnknown := false
	for i := 3; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--json", "-json":
			jsonOutput = true
		case "--include-unknown":
			includeUnknown = true
		case "--config", "-config":
			if i+1 >= len(os.Args) || os.Args[i+1] == "" {
				fatalCleanup("--config requires a path")
			}
			configPath = os.Args[i+1]
			i++
		}
	}

	dbPath := config.QueueDBPath(configPath)
	deleted, purged, remainingUnknown, err := cleanupJobs(dbPath, includeUnknown)
	if err != nil {
		fatalCleanup(fmt.Sprintf("cleanup failed: %v", err))
	}

	if jsonOutput {
		payload, err := json.Marshal(struct {
			Deleted       int `json:"deleted"`
			UnknownPurged int `json:"unknownPurged"`
			UnknownKept   int `json:"unknownKept"`
		}{Deleted: deleted, UnknownPurged: purged, UnknownKept: remainingUnknown})
		if err != nil {
			fatalCleanup(fmt.Sprintf("encode cleanup result: %v", err))
		}
		fmt.Println(string(payload))
	} else if includeUnknown {
		fmt.Printf("Removed %d provably terminal and %d reconciled unknown-outcome local print jobs.\n", deleted, purged)
	} else {
		fmt.Printf("Removed %d provably terminal local print jobs. %d unknown-outcome record(s) were KEPT: verify the printer, then re-run with --include-unknown once reconciled.\n", deleted, remainingUnknown)
	}
	os.Exit(0)
}

// cleanupJobs removes provably terminal rows, and only when explicitly
// asked (the operator has physically reconciled the output) the rows whose
// physical outcome is unknown. Returns (deleted, unknownPurged, unknownKept, err).
func cleanupJobs(dbPath string, includeUnknown bool) (int, int, int, error) {
	// Ensure the parent directory exists first: a missing data dir must
	// yield an empty result, not a sqlite "unable to open" failure, and
	// this also covers fresh machines where the agent never ran.
	if dir := filepath.Dir(dbPath); dir != "" {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return 0, 0, 0, fmt.Errorf("create queue directory %s: %w", dir, err)
		}
	}
	q, err := queue.New(dbPath)
	if err != nil {
		return 0, 0, 0, err
	}
	defer q.Close()
	deleted, err := q.CleanupTerminal()
	if err != nil {
		return 0, 0, 0, err
	}
	kept, err := q.CountOutcomeUnknown()
	if err != nil {
		return deleted, 0, 0, err
	}
	if includeUnknown && kept > 0 {
		purged, err := q.PurgeOutcomeUnknown()
		if err != nil {
			return deleted, 0, 0, err
		}
		return deleted, purged, 0, nil
	}
	return deleted, 0, kept, nil
}

func fatalCleanup(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
