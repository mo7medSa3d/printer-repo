package config

import (
	"path/filepath"
	"testing"
)

func TestDefaultConfigDisablesCrashReprint(t *testing.T) {
	cfg := defaultConfig()
	if cfg.ReprintAfterCrashEnabled() {
		t.Fatal("crash reprint must be opt-in by default")
	}
}

func TestLoadMissingConfigUsesSafeCrashPolicy(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "missing.yaml"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ReprintAfterCrashEnabled() {
		t.Fatal("missing config must use the safe no-reprint default")
	}
}

func TestExplicitCrashReprintOptIn(t *testing.T) {
	cfg := defaultConfig()
	yes := true
	cfg.Agent.ReprintAfterCrash = &yes
	if !cfg.ReprintAfterCrashEnabled() {
		t.Fatal("explicit true must enable at-least-once crash reprinting")
	}
}
