package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/odoo-print-agent/agent/internal/config"
	"github.com/odoo-print-agent/agent/internal/payload"
	"github.com/odoo-print-agent/agent/internal/printer"
	"github.com/odoo-print-agent/agent/internal/queue"
)

// Job concurrency limits. Physical printing is serialized per printer, but
// without an upper bound on in-flight jobs a gateway-side burst (e.g. a large
// offline backlog delivered after a reconnect) would spawn one goroutine per
// job and exhaust memory on a small POS terminal.
//
//	maxConcurrentJobs — jobs actually executing (HTTP status calls, printing)
//	maxPendingJobs    — jobs accepted into the local executor, including ones
//	                    waiting for an execution slot; overflows are dropped
//	                    and naturally re-delivered by the gateway after the
//	                    claim lease expires (see src/app/api/agent/jobs).
const (
	maxConcurrentJobs = 8
	maxPendingJobs    = 64
)

// shutdownGrace bounds how long Run waits for in-flight jobs after the agent
// is asked to stop. The Windows SCM default stop timeout is 30s.
const shutdownGrace = 25 * time.Second

type Agent struct {
	cfg            *config.Config
	client         *http.Client
	printers       map[string]printer.Printer
	printerConfigs map[string]config.PrinterConfig
	queue          *queue.Queue
	jobLocks       map[string]*sync.Mutex
	locksMutex     sync.Mutex

	// Job executor: bounded, deduplicated, and tracked for clean shutdown.
	execSem      chan struct{}      // limits concurrently executing jobs
	pendingSlots chan struct{}      // limits accepted (executing + waiting) jobs
	inFlight     map[string]struct{} // job ids currently in the executor
	inFlightMu   sync.Mutex
	wg           sync.WaitGroup

	// Guards making heartbeat/poll ticks non-reentrant. A slow tick (offline
	// printers probing at 2s, slow gateway) must never let ticks pile up.
	hbMu   sync.Mutex
	pollMu sync.Mutex

	// shutdownCh is closed exactly once when Run begins stopping; dispatchJob
	// refuses new work afterwards so the queue is never closed while jobs are
	// still being scheduled.
	shutdownCh  chan struct{}
	shutdownOne sync.Once
	closeOne    sync.Once

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
		execSem:        make(chan struct{}, maxConcurrentJobs),
		pendingSlots:   make(chan struct{}, maxPendingJobs),
		inFlight:       make(map[string]struct{}),
		shutdownCh:     make(chan struct{}),
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

// Close releases the durable local queue. Call it during shutdown, after Run
// has drained in-flight jobs, so the SQLite WAL file is checkpointed and the
// handle is not leaked for the lifetime of the process.
//
// The queue field is deliberately NOT nil-ed: a straggler job goroutine that
// slips past the shutdown gate must get a clean "sql: database is closed"
// error from database/sql, never a nil-pointer panic.
func (a *Agent) Close() error {
	var cerr error
	a.closeOne.Do(func() {
		if a.queue != nil {
			cerr = a.queue.Close()
		}
	})
	return cerr
}

// beginShutdown atomically closes the job-acceptance gate. Safe to call more
// than once (e.g. service stop after an interactive Ctrl+C).
func (a *Agent) beginShutdown() {
	a.shutdownOne.Do(func() { close(a.shutdownCh) })
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
	go a.sendHeartbeatGuarded()
	go a.pollJobsGuarded(ctx)

	for {
		select {
		case <-ctx.Done():
			log.Println("Agent stopping...")
			a.beginShutdown()
			if c := a.getWSConn(); c != nil {
				_ = c.Close()
			}
			a.waitForJobs()
			return nil
		case <-heartbeatTicker.C:
			// Never block the select loop: heartbeat probes TCP-reachability
			// of every configured printer, which can take seconds when offline.
			go a.sendHeartbeatGuarded()
		case <-pollTicker.C:
			// Fallback polling only when WebSocket is not currently connected.
			if a.getWSConn() == nil {
				go a.pollJobsGuarded(ctx)
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
				// Jittered backoff (50%-100% of the step) avoids thundering
				// reconnect herds when the gateway restarts with many agents.
				delay := backoff/2 + time.Duration(rand.Int63n(int64(backoff/2)+1))
				log.Printf("WebSocket dial failed: %v. Retrying in %s...", err, delay.Round(time.Millisecond))
				select {
				case <-ctx.Done():
					return
				case <-time.After(delay):
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
			_ = c.Close()
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

		a.dispatchJob(ctx, job)
	}
}

// dispatchJob schedules exactly one job for execution under three safety
// rules:
//
//  1. Dedupe: a job id already being executed/waiting is dropped (the gateway
//     can legitimately deliver the same job over WS and the poll fallback).
//  2. Bounded backlog: at most maxPendingJobs are in flight; beyond that the
//     job is dropped and the gateway re-delivers after the claim lease.
//  3. Bounded execution: at most maxConcurrentJobs execute at once; per-
//     printer serialization still happens inside processJob.
//
// It never blocks the caller (WS read loop / poll loop) for more than
// bookkeeping, so WebSocket ping/pong handling is never starved.
func (a *Agent) dispatchJob(ctx context.Context, job map[string]interface{}) {
	jobID, _ := job["id"].(string)
	if jobID == "" {
		log.Printf("Received malformed job (missing id); ignoring: %v", job)
		return
	}

	// The shutdown check, dedupe insert, and WaitGroup Add must be atomic with
	// respect to each other: Run begins its Wait only after the shutdownCh is
	// closed, so any Add that passes the gate is guaranteed to happen before
	// that Wait — a late Add can never race with a Wait observing a zero
	// counter (sync.WaitGroup's forbidden interleaving).
	a.inFlightMu.Lock()
	select {
	case <-a.shutdownCh:
		a.inFlightMu.Unlock()
		return // gateway reclaims and re-delivers unprocessed claimed jobs
	default:
	}
	if _, dup := a.inFlight[jobID]; dup {
		a.inFlightMu.Unlock()
		log.Printf("Job %s is already in flight; duplicate delivery ignored.", jobID)
		return
	}
	a.inFlight[jobID] = struct{}{}
	a.wg.Add(1)
	a.inFlightMu.Unlock()

	select {
	case a.pendingSlots <- struct{}{}:
	default:
		a.forgetJob(jobID)
		a.wg.Done() // undo the reservation; no goroutine will run
		log.Printf("Job %s dropped: %d jobs already in flight; gateway will re-deliver after the claim lease expires.", jobID, maxPendingJobs)
		return
	}

	go func() {
		defer a.wg.Done()
		defer func() { <-a.pendingSlots }()
		defer a.forgetJob(jobID)
		// Recovery must be registered AFTER the slot-release defers so it runs
		// first (LIFO) and the cleanup defers still execute on panic.
		defer func() {
			if r := recover(); r != nil {
				log.Printf("PANIC while executing job %s: %v", jobID, r)
			}
		}()

		select {
		case a.execSem <- struct{}{}:
			defer func() { <-a.execSem }()
		case <-ctx.Done():
			return
		}

		a.processJob(ctx, job)
	}()
}

func (a *Agent) forgetJob(id string) {
	a.inFlightMu.Lock()
	delete(a.inFlight, id)
	a.inFlightMu.Unlock()
}

// waitForJobs blocks until in-flight job handlers finish (bounded by
// shutdownGrace), so the SQLite queue is never closed mid-write on service
// stop. Surviving the deadline is safe: WAL is crash-durable and the gateway
// reclaims stale claimed jobs automatically.
func (a *Agent) waitForJobs() {
	done := make(chan struct{})
	go func() {
		a.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		log.Println("All in-flight jobs finished cleanly.")
	case <-time.After(shutdownGrace):
		log.Printf("WARNING: shutdown grace period (%s) reached with jobs still in flight.", shutdownGrace)
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

// sendHeartbeatGuarded makes heartbeat ticks non-reentrant: if the previous
// heartbeat is still running (slow gateway, many offline printers) the tick
// is skipped instead of queueing up duplicate probes and HTTP calls.
func (a *Agent) sendHeartbeatGuarded() {
	if !a.hbMu.TryLock() {
		return
	}
	defer a.hbMu.Unlock()
	a.sendHeartbeat()
}

// pollJobsGuarded is the non-reentrant variant for the poll fallback.
func (a *Agent) pollJobsGuarded(ctx context.Context) {
	if !a.pollMu.TryLock() {
		return
	}
	defer a.pollMu.Unlock()
	a.pollJobs(ctx)
}

// printerStatusPayload builds the printer-sync block sent on every
// heartbeat, using the agent's OWN view of its configured printers - the
// server must never be trusted to tell an agent what printers it has.
//
// TCP probes run concurrently: a sequential probe of N offline printers (2s
// dial timeout each) used to stall the whole heartbeat for 2*N seconds.
func (a *Agent) printerStatusPayload() []map[string]interface{} {
	ids := make([]string, 0, len(a.printers))
	for id := range a.printers {
		ids = append(ids, id)
	}
	sort.Strings(ids) // deterministic order aids gateway-side diffing

	statuses := make([]string, len(ids))
	var probeWg sync.WaitGroup
	probeWg.Add(len(ids))
	for i, id := range ids {
		go func(i int, p printer.Printer) {
			defer probeWg.Done()
			statuses[i] = p.Status()
		}(i, a.printers[id])
	}
	probeWg.Wait()

	result := make([]map[string]interface{}, 0, len(ids))
	for i, id := range ids {
		pc := a.printerConfigs[id]
		result = append(result, map[string]interface{}{
			"id":     id,
			"name":   pc.Name,
			"type":   pc.Type,
			"status": statuses[i],
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
		a.dispatchJob(ctx, job)
	}
}

// processJob executes exactly one print job end-to-end and reports the
// true outcome. It NEVER reports "success" unless the payload was
// actually transmitted to the printer backend without error. "Success"
// here means "the bytes were handed to the printer over the configured
// transport" - for RAW TCP that means the socket write succeeded, NOT
// that paper physically came out. See PRINTERS.md for the documented
// delivery semantics.
//
// Callers should normally schedule it through dispatchJob; the tests drive
// it directly.
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
