package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/odoo-print-agent/agent/internal/config"
	"github.com/odoo-print-agent/agent/internal/payload"
	"github.com/odoo-print-agent/agent/internal/printer"
	"github.com/odoo-print-agent/agent/internal/queue"
)

type Agent struct {
	cfg            *config.Config
	client         *http.Client
	printers       map[string]printer.Printer
	printerConfigs map[string]config.PrinterConfig
	queue          *queue.Queue
	jobLocks       map[string]*sync.Mutex
	locksMutex     sync.Mutex

	wsMu   sync.RWMutex
	wsConn *websocket.Conn
}

// New builds the agent and initializes every configured printer backend.
// A printer that fails to initialize (bad config, unsupported type) is
// logged and skipped rather than aborting the whole agent - other
// printers on the same agent must keep working.
func New(cfg *config.Config, configPath string) (*Agent, error) {
	dbPath := config.QueueDBPath(configPath)
	q, err := queue.New(dbPath)
	if err != nil {
		return nil, fmt.Errorf("open local queue at %s: %w", dbPath, err)
	}

	a := &Agent{
		cfg:            cfg,
		client:         &http.Client{Timeout: 15 * time.Second},
		printers:       make(map[string]printer.Printer),
		printerConfigs: make(map[string]config.PrinterConfig),
		queue:          q,
		jobLocks:       make(map[string]*sync.Mutex),
	}

	for _, pc := range cfg.Printers {
		p, err := printer.New(pc)
		if err != nil {
			log.Printf("WARNING: printer %q (%s) not initialized: %v", pc.ID, pc.Name, err)
			continue
		}
		a.printers[pc.ID] = p
		a.printerConfigs[pc.ID] = pc
	}

	if len(a.printers) == 0 {
		log.Printf("WARNING: no printers were successfully initialized from config; jobs will fail until printers are configured correctly")
	}

	return a, nil
}

func (a *Agent) Run(ctx context.Context) error {
	if a.cfg.Agent.ID == "" {
		log.Println("CRITICAL: Agent not registered. Staying alive so the desktop manager can pair it.")
		<-ctx.Done()
		return nil
	}

	log.Printf("Agent %s starting (ID: %s, %d printer(s) configured)", a.cfg.Agent.Name, a.cfg.Agent.ID, len(a.printers))

	go a.connectWebSocket(ctx)

	heartbeatTicker := time.NewTicker(30 * time.Second)
	pollTicker := time.NewTicker(10 * time.Second) // Fallback poll
	defer heartbeatTicker.Stop()
	defer pollTicker.Stop()

	// Send an immediate heartbeat/poll on startup instead of waiting a full tick.
	a.sendHeartbeat()
	a.pollJobs(ctx)

	for {
		select {
		case <-ctx.Done():
			log.Println("Agent stopping...")
			if c := a.getWSConn(); c != nil {
				c.Close()
			}
			return nil
		case <-heartbeatTicker.C:
			a.sendHeartbeat()
		case <-pollTicker.C:
			// Fallback polling only when WebSocket is not currently connected.
			if a.getWSConn() == nil {
				a.pollJobs(ctx)
			}
		}
	}
}

func (a *Agent) getWSConn() *websocket.Conn {
	a.wsMu.RLock()
	defer a.wsMu.RUnlock()
	return a.wsConn
}

func (a *Agent) setWSConn(c *websocket.Conn) {
	a.wsMu.Lock()
	a.wsConn = c
	a.wsMu.Unlock()
}

func (a *Agent) connectWebSocket(ctx context.Context) {
	u, err := url.Parse(a.cfg.Server.URL)
	if err != nil {
		log.Printf("Invalid server URL: %v", err)
		return
	}

	scheme := "wss"
	if u.Scheme == "http" {
		scheme = "ws"
	}

	wsURL := fmt.Sprintf("%s://%s/api/agent/ws", scheme, u.Host)

	backoff := 5 * time.Second
	const maxBackoff = 60 * time.Second

	for {
		select {
		case <-ctx.Done():
			return
		default:
			log.Printf("Connecting to WebSocket: %s", wsURL)
			header := http.Header{}
			header.Set("Authorization", fmt.Sprintf("Bearer %s:%s", a.cfg.Agent.ID, a.cfg.Agent.Secret))

			c, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, header)
			if err != nil {
				log.Printf("WebSocket dial failed: %v. Retrying in %s...", err, backoff)
				select {
				case <-ctx.Done():
					return
				case <-time.After(backoff):
				}
				if backoff < maxBackoff {
					backoff *= 2
					if backoff > maxBackoff {
						backoff = maxBackoff
					}
				}
				continue
			}

			backoff = 5 * time.Second
			a.setWSConn(c)
			log.Println("WebSocket connected.")

			err = a.handleWSMessages(ctx)
			a.setWSConn(nil)
			c.Close()
			if err != nil {
				log.Printf("WebSocket connection lost: %v. Reconnecting...", err)
			}
		}
	}
}

func (a *Agent) handleWSMessages(ctx context.Context) error {
	for {
		conn := a.getWSConn()
		if conn == nil {
			return fmt.Errorf("connection closed")
		}
		_, message, err := conn.ReadMessage()
		if err != nil {
			return err
		}

		var job map[string]interface{}
		if err := json.Unmarshal(message, &job); err != nil {
			log.Printf("Malformed WS message: %v", err)
			continue
		}

		go a.processJob(ctx, job)
	}
}

func (a *Agent) getPrinterLock(printerID string) *sync.Mutex {
	a.locksMutex.Lock()
	defer a.locksMutex.Unlock()
	if _, ok := a.jobLocks[printerID]; !ok {
		a.jobLocks[printerID] = &sync.Mutex{}
	}
	return a.jobLocks[printerID]
}

// printerStatusPayload builds the printer-sync block sent on every
// heartbeat, using the agent's OWN view of its configured printers - the
// server must never be trusted to tell an agent what printers it has.
func (a *Agent) printerStatusPayload() []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(a.printers))
	for id, p := range a.printers {
		pc := a.printerConfigs[id]
		result = append(result, map[string]interface{}{
			"id":     id,
			"name":   pc.Name,
			"type":   pc.Type,
			"status": p.Status(),
			"config": endpointToConfig(pc),
		})
	}
	return result
}

// endpointToConfig normalizes the agent's local "ip:port" endpoint string
// into the {ip, port, protocol} / {address, protocol} shape the gateway's
// printer.config JSON column expects.
func endpointToConfig(pc config.PrinterConfig) map[string]interface{} {
	cfgMap := map[string]interface{}{"protocol": pc.Protocol}
	if pc.Type == "network" {
		host, portStr, err := net.SplitHostPort(pc.Endpoint)
		if err == nil {
			cfgMap["ip"] = host
			if port, err := strconv.Atoi(portStr); err == nil {
				cfgMap["port"] = port
			}
		} else {
			cfgMap["ip"] = pc.Endpoint
		}
	} else {
		cfgMap["address"] = pc.Endpoint
	}
	return cfgMap
}

func (a *Agent) sendHeartbeat() {
	reqURL := fmt.Sprintf("%s/api/agent/heartbeat", a.cfg.Server.URL)
	payload := map[string]interface{}{
		"status":   "online",
		"printers": a.printerStatusPayload(),
	}
	resp, err := a.doAuthorizedRequest("POST", reqURL, payload)
	if err != nil {
		log.Printf("Heartbeat failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("Heartbeat rejected (%d): %s", resp.StatusCode, string(body))
	}
}

func (a *Agent) pollJobs(ctx context.Context) {
	reqURL := fmt.Sprintf("%s/api/agent/jobs", a.cfg.Server.URL)
	resp, err := a.doAuthorizedRequest("GET", reqURL, nil)
	if err != nil {
		log.Printf("Poll failed: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("Poll rejected (%d): %s", resp.StatusCode, string(body))
		return
	}

	var jobs []map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&jobs); err != nil {
		log.Printf("Poll: failed to decode job list: %v", err)
		return
	}

	for _, job := range jobs {
		go a.processJob(ctx, job)
	}
}

// processJob executes exactly one print job end-to-end and reports the
// true outcome. It NEVER reports "success" unless the payload was
// actually transmitted to the printer backend without error. "Success"
// here means "the bytes were handed to the printer over the configured
// transport" - for RAW TCP that means the socket write succeeded, NOT
// that paper physically came out. See PRINTERS.md for the documented
// delivery semantics.
func (a *Agent) processJob(ctx context.Context, job map[string]interface{}) {
	jobID, _ := job["id"].(string)
	printerID, _ := job["printerId"].(string)
	expiresAtStr, _ := job["expiresAt"].(string)

	if jobID == "" || printerID == "" {
		log.Printf("Received malformed job (missing id/printerId); ignoring: %v", job)
		return
	}

	if expiresAtStr != "" {
		if expiresAt, err := time.Parse(time.RFC3339, expiresAtStr); err == nil {
			if time.Now().UTC().After(expiresAt.UTC()) {
				log.Printf("Job %s expired before agent processing. Skipping.", jobID)
				a.updateJobStatus(jobID, "expired", "TTL exceeded before agent processing")
				return
			}
		}
	}

	if a.queue.IsProcessed(jobID) {
		log.Printf("Job %s already successfully processed locally. Skipping duplicate print.", jobID)
		return
	}

	p, ok := a.printers[printerID]
	if !ok {
		log.Printf("Job %s references printer %s which is not configured on this agent", jobID, printerID)
		a.updateJobStatus(jobID, "failed", fmt.Sprintf("printer %s is not configured on this agent", printerID))
		return
	}

	pl, err := payload.Parse(job["payload"])
	if err != nil {
		log.Printf("Job %s has an invalid payload: %v", jobID, err)
		a.updateJobStatus(jobID, "failed", fmt.Sprintf("invalid payload: %v", err))
		return
	}

	// Per-printer serialization: two jobs for the same printer never run concurrently.
	lock := a.getPrinterLock(printerID)
	lock.Lock()
	defer lock.Unlock()

	// Re-check idempotency now that we hold the lock, in case a racing
	// delivery (WS + poll fallback both firing) got here first.
	if a.queue.IsProcessed(jobID) {
		log.Printf("Job %s was already processed while waiting for the printer lock. Skipping.", jobID)
		return
	}

	log.Printf("Printing job %s on printer %s (%d bytes, type=%s)", jobID, printerID, len(pl.Data), pl.Type)

	if err := a.queue.Push(jobID, printerID, pl.Data); err != nil {
		log.Printf("Job %s: failed to persist to local durable queue (continuing anyway): %v", jobID, err)
	}
	a.queue.UpdateStatus(jobID, "printing")
	a.updateJobStatus(jobID, "printing", "")

	printCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	if err := p.Print(printCtx, pl.Data); err != nil {
		log.Printf("Job %s FAILED on printer %s: %v", jobID, printerID, err)
		a.queue.UpdateStatus(jobID, "failed")
		a.updateJobStatus(jobID, "failed", err.Error())
		return
	}

	log.Printf("Job %s: payload transmitted successfully to printer %s", jobID, printerID)
	a.queue.UpdateStatus(jobID, "success")
	a.updateJobStatus(jobID, "success", "")
}

func (a *Agent) updateJobStatus(jobID, status, errMsg string) {
	reqURL := fmt.Sprintf("%s/api/agent/jobs", a.cfg.Server.URL)
	body := map[string]interface{}{
		"jobId":  jobID,
		"status": status,
		"error":  errMsg,
	}
	resp, err := a.doAuthorizedRequest("PATCH", reqURL, body)
	if err != nil {
		log.Printf("Job %s: failed to report status %q to server: %v", jobID, status, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		log.Printf("Job %s: server rejected status update to %q (%d): %s", jobID, status, resp.StatusCode, string(respBody))
	}
}

func (a *Agent) doAuthorizedRequest(method, url string, body interface{}) (*http.Response, error) {
	var buf io.Reader
	if body != nil {
		b := new(bytes.Buffer)
		if err := json.NewEncoder(b).Encode(body); err != nil {
			return nil, fmt.Errorf("encode request body: %w", err)
		}
		buf = b
	}

	req, err := http.NewRequest(method, url, buf)
	if err != nil {
		return nil, err
	}

	// Never log this header - it contains the agent credential.
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s:%s", a.cfg.Agent.ID, a.cfg.Agent.Secret))
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode == http.StatusUnauthorized {
		log.Printf("CRITICAL: Agent %s unauthorized by server. Credentials may have been revoked; re-pair this agent.", a.cfg.Agent.ID)
	}

	return resp, nil
}
