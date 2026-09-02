package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/odoo-print-agent/agent/internal/config"
)

// Register pairs this machine with the Gateway and persists the credentials
// next to the existing config file. The secret is written to
// %PROGRAMDATA%\OdooPrintAgent\config.yaml and is never echoed to stdout.
func Register(serverURL, pairingCode, configPath string) error {
	serverURL = strings.TrimRight(strings.TrimSpace(serverURL), "/")
	u, err := url.Parse(serverURL)
	if err != nil {
		return fmt.Errorf("invalid server URL: %w", err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return fmt.Errorf("server URL must be http:// or https://")
	}
	if u.Host == "" {
		return fmt.Errorf("server URL host is empty")
	}
	if strings.TrimSpace(pairingCode) == "" {
		return fmt.Errorf("pairing code is empty")
	}

	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "unknown-host"
	}

	payload := map[string]interface{}{
		"pairingCode": strings.ToUpper(strings.TrimSpace(pairingCode)),
		"metadata": map[string]string{
			"hostname": hostname,
			"os":       runtime.GOOS,
			"arch":     runtime.GOARCH,
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode registration request: %w", err)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/agent/register", serverURL), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create registration request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "odoo-print-agent-cli/1")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("registration request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		return fmt.Errorf("registration failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var data struct {
		AgentID string `json:"agentId"`
		Secret  string `json:"secret"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&data); err != nil {
		return fmt.Errorf("decode registration response: %w", err)
	}
	if data.AgentID == "" || data.Secret == "" {
		return fmt.Errorf("registration response did not contain agentId/secret")
	}

	// Load the existing config so printer configuration and agent name are
	// preserved. config.Ensure already created the file on a fresh install.
	cfg, err := config.Load(configPath)
	if err != nil {
		return fmt.Errorf("load config before saving credentials: %w", err)
	}
	cfg.Server.URL = serverURL
	cfg.Agent.ID = data.AgentID
	cfg.Agent.Secret = data.Secret
	if cfg.Agent.Name == "" {
		cfg.Agent.Name = hostname
	}

	if err := cfg.Save(configPath); err != nil {
		return fmt.Errorf("save credentials: %w", err)
	}

	fmt.Printf("Success! Agent registered as %s\n", data.AgentID)
	fmt.Println("Restart the agent (or start it from Odoo Print Manager) to begin receiving jobs.")
	return nil
}
