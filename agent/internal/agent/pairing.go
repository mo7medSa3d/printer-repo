package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"

	"github.com/odoo-print-agent/agent/internal/config"
)

func Register(serverURL, pairingCode, configPath string) error {
	fmt.Printf("Registering agent with code %s at %s...\n", pairingCode, serverURL)

	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "unknown-host"
	}

	payload := map[string]interface{}{
		"pairingCode": pairingCode,
		"metadata": map[string]string{
			"hostname": hostname,
			"os":       runtime.GOOS,
		},
	}

	body, _ := json.Marshal(payload)
	resp, err := http.Post(fmt.Sprintf("%s/api/agent/register", serverURL), "application/json", bytes.NewBuffer(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("registration failed (%d): %s", resp.StatusCode, string(respBody))
	}

	var data struct {
		AgentID string `json:"agentId"`
		Secret  string `json:"secret"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return err
	}

	// Save to config
	cfg, _ := config.Load(configPath)
	cfg.Server.URL = serverURL
	cfg.Agent.ID = data.AgentID
	cfg.Agent.Secret = data.Secret
	cfg.Agent.Name = "Registered Agent"

	if err := cfg.Save(configPath); err != nil {
		return err
	}

	fmt.Printf("Success! Agent registered as %s\n", data.AgentID)
	return nil
}
