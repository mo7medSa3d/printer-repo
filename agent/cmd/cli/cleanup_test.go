package main

import (
	"path/filepath"
	"testing"
)

func TestParseCleanupArgsSupportsLeadingAndTrailingGlobalFlags(t *testing.T) {
	want := filepath.Join(t.TempDir(), "agent.yaml")
	cases := []struct {
		name       string
		args       []string
		matched    bool
		jsonOutput bool
		include    bool
		wantConfig string
	}{
		{"trailing flags", []string{"jobs", "cleanup", "--json", "--include-unknown", "--config", want}, true, true, true, want},
		{"leading config", []string{"--config", want, "jobs", "cleanup", "--json"}, true, true, false, want},
		{"legacy no flags", []string{"jobs", "cleanup"}, true, false, false, ""},
		{"not cleanup", []string{"jobs", "list"}, false, false, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotConfig, gotJSON, gotInclude, gotMatch, err := parseCleanupArgs(tc.args)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if gotMatch != tc.matched || gotJSON != tc.jsonOutput || gotInclude != tc.include {
				t.Fatalf("got match=%v json=%v include=%v", gotMatch, gotJSON, gotInclude)
			}
			if tc.wantConfig != "" && gotConfig != tc.wantConfig {
				t.Fatalf("got config %q want %q", gotConfig, tc.wantConfig)
			}
		})
	}
}

func TestParseCleanupArgsRejectsMissingConfigValue(t *testing.T) {
	_, _, _, matched, err := parseCleanupArgs([]string{"jobs", "cleanup", "--config"})
	if !matched || err == nil {
		t.Fatalf("expected matched cleanup command with a config-value error")
	}
}
