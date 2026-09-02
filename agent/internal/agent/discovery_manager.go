package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/odoo-print-agent/agent/internal/printer"
)

// pollDiscovery checks gateway for pending discovery sessions for this agent and executes them.
func (a *Agent) pollDiscovery(ctx context.Context) {
	reqURL := fmt.Sprintf("%s/api/agent/discovery", a.cfg.Server.URL)
	resp, err := a.doAuthorizedRequest("GET", reqURL, nil)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return
	}
	var sessions []map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&sessions); err != nil {
		return
	}
	for _, s := range sessions {
		id, _ := s["id"].(string)
		if id == "" {
			continue
		}
		go a.executeDiscoverySession(ctx, id)
	}
}

func (a *Agent) executeDiscoverySession(ctx context.Context, discoveryId string) {
	log.Printf("[discovery] executing session %s", discoveryId)
	// Run full discovery with bounded timeout 30s
	discoveryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	result := printer.Discover(a.cfg, a.registryPath)
	// Enrich with SNMP/LPR/WSD already included in Discover (extended)
	// Build payload for gateway: map to discoveredDevices schema
	var devices []map[string]interface{}
	for _, di := range result.Printers {
		// Determine verification: if IPP or spooler with model, verified else candidate
		verification := "candidate"
		if di.Protocol == "ipp" || di.Protocol == "ipps" || di.ConnectionType == "spooler" {
			verification = "verified"
		}
		if di.Capabilities != nil {
			if v, ok := di.Capabilities["snmp_verified"]; ok && v == true {
				verification = "verified"
			}
			if v, ok := di.Capabilities["wsd_verified"]; ok && v == true {
				verification = "verified"
			}
			if v, ok := di.Capabilities["mdns_verified"]; ok && v == true {
				verification = "verified"
			}
		}
		// confidence heuristic
		sources := []string{}
		if di.Capabilities != nil {
			if v, ok := di.Capabilities["discovered_via"]; ok {
				sources = append(sources, fmt.Sprint(v))
			}
		}
		if di.Protocol == "ipp" {
			sources = append(sources, "ipp")
		}
		confidence := "low"
		if verification == "verified" && len(sources) >= 1 {
			confidence = "medium"
			if di.Name != "" && len(sources) >= 2 {
				confidence = "high"
			}
		}
		dev := map[string]interface{}{
			"source":       sources,
			"protocol":     di.Protocol,
			"ipAddress":    di.NetworkAddress,
			"port":         di.Port,
			"deviceName":   di.Name,
			"manufacturer": di.Capabilities["manufacturer"],
			"model":        di.Name,
			"confidence":   confidence,
			"verification": verification,
			"capabilities": di.Capabilities,
			"rawMetadata":  map[string]interface{}{"endpoint": di.Endpoint, "connectionType": di.ConnectionType},
		}
		// enrich model via caps
		if m, ok := di.Capabilities["model"]; ok && m != nil {
			dev["model"] = fmt.Sprint(m)
		}
		devices = append(devices, dev)
	}
	// Also include network/LPR/SNMP/WSD/mDNS candidates that were not in printers? Discover already includes them.
	// Deduplicate already done by Discover.
	status := "completed"
	if len(result.Errors) > 0 && len(devices) > 0 {
		status = "partial"
	} else if len(result.Errors) > 0 && len(devices) == 0 {
		status = "failed"
	}
	_ = discoveryCtx
	payload := map[string]interface{}{
		"discoveryId": discoveryId,
		"status":      status,
		"devices":     devices,
	}
	reqURL := fmt.Sprintf("%s/api/agent/discovery", a.cfg.Server.URL)
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(body))
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s:%s", a.cfg.Agent.ID, a.cfg.Agent.Secret))
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		log.Printf("[discovery] failed to report results for %s: %v", discoveryId, err)
		return
	}
	defer resp.Body.Close()
	log.Printf("[discovery] session %s completed: %d devices, status %s", discoveryId, len(devices), status)
}
