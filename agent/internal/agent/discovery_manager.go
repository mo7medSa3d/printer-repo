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
		// At most one discovery session runs at a time (full bounded LAN
		// scan). A pending session expires on the gateway in 60s and each
		// run is bounded to 30s, so anything skipped here is simply picked
		// up on the next 30s poll tick — no goroutine pile-up.
		select {
		case a.discoverySem <- struct{}{}:
			go func(sessionID string) {
				defer func() { <-a.discoverySem }()
				a.executeDiscoverySession(ctx, sessionID)
			}(id)
		default:
			log.Printf("[discovery] session %s deferred: a discovery session is already running", id)
		}
	}
}

func (a *Agent) executeDiscoverySession(ctx context.Context, discoveryID string) {
	log.Printf("[discovery] executing session %s", discoveryID)

	// Enforce a hard orchestration bound even though individual detectors have
	// their own shorter network timeouts. The result channel is buffered so a
	// detector that finishes just after cancellation cannot block forever.
	discoveryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	resultCh := make(chan printer.DiscoveryResult, 1)
	go func() {
		resultCh <- printer.Discover(a.cfg, a.registryPath)
	}()

	var result printer.DiscoveryResult
	select {
	case result = <-resultCh:
	case <-discoveryCtx.Done():
		status := "failed"
		if discoveryCtx.Err() == context.Canceled {
			status = "cancelled"
		}
		log.Printf("[discovery] session %s exceeded 30s bound: %v", discoveryID, discoveryCtx.Err())
		a.reportDiscoveryResult(ctx, discoveryID, status, nil)
		return
	}

	var devices []map[string]interface{}
	for _, di := range result.Printers {
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

		if di.Capabilities != nil {
			if m, ok := di.Capabilities["model"]; ok && m != nil {
				dev["model"] = fmt.Sprint(m)
			}
		}
		devices = append(devices, dev)
	}

	status := "completed"
	if len(result.Errors) > 0 && len(devices) > 0 {
		status = "partial"
	} else if len(result.Errors) > 0 {
		status = "failed"
	}

	a.reportDiscoveryResult(ctx, discoveryID, status, devices)
}

func (a *Agent) reportDiscoveryResult(ctx context.Context, discoveryID, status string, devices []map[string]interface{}) {
	payload := map[string]interface{}{
		"discoveryId": discoveryID,
		"status":      status,
		"devices":     devices,
	}
	reqURL := fmt.Sprintf("%s/api/agent/discovery", a.cfg.Server.URL)
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[discovery] failed to encode results for %s: %v", discoveryID, err)
		return
	}

	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(body))
	if err != nil {
		log.Printf("[discovery] failed to build report request for %s: %v", discoveryID, err)
		return
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s:%s", a.cfg.Agent.ID, a.cfg.Agent.Secret))
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.client.Do(req)
	if err != nil {
		log.Printf("[discovery] failed to report results for %s: %v", discoveryID, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("[discovery] gateway rejected results for %s: HTTP %d", discoveryID, resp.StatusCode)
		return
	}
	log.Printf("[discovery] session %s completed: %d devices, status %s", discoveryID, len(devices), status)
}
