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
	"strings"
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

// While the WebSocket is connected the poll loop still runs every
// wsSafetyPollEvery ticks (10s tick => every 30s) so claimed-but-undelivered
// jobs are reclaimed after the gateway's 90s claim lease instead of being
// stuck until the socket drops.
const wsSafetyPollEvery = 3

type Agent struct {
	cfg          *config.Config
	configPath   string
	registryPath string
	client       *http.Client
	// printersMu protects printers and printerConfigs: the async discovery
	// goroutine and Discover/RegisterManual mutate them while heartbeat
	// payloads and job dispatch read them concurrently.
	printersMu     sync.RWMutex
	printers       map[string]printer.Printer
	printerConfigs map[string]config.PrinterConfig
	queue          *queue.Queue
	jobLocks       map[string]*sync.Mutex
	locksMutex     sync.Mutex

	// Job executor: bounded, deduplicated, and tracked for clean shutdown.
	execSem      chan struct{}       // limits concurrently executing jobs
	pendingSlots chan struct{}       // limits accepted (executing + waiting) jobs
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
	// wsWriteMu serializes writes on the WebSocket: gorilla/websocket allows
	// at most one concurrent writer, and job acknowledgements are written from
	// the read loop while pings/other frames may be written elsewhere.
	wsWriteMu sync.Mutex
}

// Printer map accessors. The printer map is mutated by the async discovery
// goroutine started in New and by Discover/RegisterManual, while heartbeat
// status payloads and job dispatch read it concurrently — all access must go
// through these helpers.
func (a *Agent) addPrinter(id string, p printer.Printer, pc config.PrinterConfig) bool {
	a.printersMu.Lock()
	defer a.printersMu.Unlock()
	if _, exists := a.printers[id]; exists {
		return false
	}
	a.printers[id] = p
	a.printerConfigs[id] = pc
	return true
}

func (a *Agent) getPrinter(id string) (printer.Printer, bool) {
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()
	p, ok := a.printers[id]
	return p, ok
}

func (a *Agent) printerCount() int {
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()
	return len(a.printers)
}

// New builds the agent and initializes every configured printer backend.
// A printer that fails to initialize (bad config, unsupported type) is
// logged and skipped rather than aborting the whole agent - other
// printers on the same agent must keep working.
// It also loads the persistent discovery registry (printers.json) and merges
// discovered/manual printers idempotently, so repeated discovery does not
// create duplicates and the production config does not depend on printers: [].
func New(cfg *config.Config, configPath string) (*Agent, error) {
	dbPath := config.QueueDBPath(configPath)
	q, err := queue.New(dbPath)
	if err != nil {
		return nil, fmt.Errorf("open local queue at %s: %w", dbPath, err)
	}

	registryPath := config.RegistryPath(configPath)

	a := &Agent{
		cfg:            cfg,
		configPath:     configPath,
		registryPath:   registryPath,
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

	// An explicitly configured PDF helper takes precedence over the platform
	// PDF path for every PDF-capable backend on this agent.
	printer.SetPDFHelperCommand(cfg.Agent.PDFPrintCommand)

	// 1. Load configured printers from YAML (legacy, still supported for backward compat)
	for _, pc := range cfg.Printers {
		p, err := printer.New(pc)
		if err != nil {
			log.Printf("WARNING: printer %q (%s) not initialized: %v", pc.ID, pc.Name, err)
			continue
		}
		a.addPrinter(pc.ID, p, pc)
	}

	// 2. Merge registry printers (discovered + manually registered) — idempotent.
	// Phase14: Do quick local discovery synchronously (config+spooler+registry) to avoid
	// blocking startup on 8s LAN scan. Full network/USB discovery runs asynchronously.
	quick := printer.DiscoverQuick(cfg, registryPath)
	if len(quick.Errors) > 0 {
		for _, e := range quick.Errors {
			log.Printf("discovery warning: %s", e)
		}
	}
	if len(quick.Printers) > 0 {
		if merged, err := printer.UpsertRegistry(registryPath, quick.Printers); err == nil {
			for _, di := range merged {
				if _, exists := a.getPrinter(di.ID); exists {
					continue
				}
				pc := config.PrinterConfig{
					ID:           di.ID,
					Name:         di.Name,
					Type:         di.ConnectionType,
					Endpoint:     di.Endpoint,
					Protocol:     di.Protocol,
					SpoolerName:  di.SpoolerName,
					PrinterType:  di.PrinterType,
					USBVID:       di.USBVID,
					USBPID:       di.USBPID,
					USBSerial:    di.USBSerial,
					Capabilities: di.Capabilities,
				}
				if di.ConnectionType == "spooler" && pc.SpoolerName == "" {
					pc.SpoolerName = di.SpoolerName
				}
				p, err := printer.New(pc)
				if err != nil {
					log.Printf("WARNING: registry printer %q (%s) not initialized: %v", di.ID, di.Name, err)
					continue
				}
				a.addPrinter(di.ID, p, pc)
			}
		} else {
			log.Printf("WARNING: failed to persist discovery registry: %v", err)
		}
	}
	// 3. Full discovery (network+USB) asynchronously — additive, bounded, not blocking startup
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[discovery] async full discovery panic: %v", r)
			}
		}()
		// Small delay to let gateway communication start first
		time.Sleep(2 * time.Second)
		log.Printf("[discovery] starting async full discovery (network+USB)")
		full := printer.Discover(cfg, registryPath)
		if len(full.Errors) > 0 {
			for _, e := range full.Errors {
				log.Printf("discovery warning: %s", e)
			}
		}
		if len(full.Printers) > len(quick.Printers) {
			log.Printf("[discovery] async discovery found %d printers (quick had %d), updating registry", len(full.Printers), len(quick.Printers))
			if merged, err := printer.UpsertRegistry(registryPath, full.Printers); err == nil {
				for _, di := range merged {
					if _, exists := a.getPrinter(di.ID); exists {
						continue
					}
					pc := config.PrinterConfig{
						ID:           di.ID,
						Name:         di.Name,
						Type:         di.ConnectionType,
						Endpoint:     di.Endpoint,
						Protocol:     di.Protocol,
						SpoolerName:  di.SpoolerName,
						PrinterType:  di.PrinterType,
						USBVID:       di.USBVID,
						USBPID:       di.USBPID,
						USBSerial:    di.USBSerial,
						Capabilities: di.Capabilities,
					}
					if di.ConnectionType == "spooler" && pc.SpoolerName == "" {
						pc.SpoolerName = di.SpoolerName
					}
					p, err := printer.New(pc)
					if err != nil {
						log.Printf("WARNING: async printer %q (%s) not initialized: %v", di.ID, di.Name, err)
						continue
					}
					if a.addPrinter(di.ID, p, pc) {
						log.Printf("[discovery] async added printer: %s (%s) type=%s", di.ID, di.Name, di.ConnectionType)
					}
				}
			}
		} else {
			log.Printf("[discovery] async discovery completed: %d printers (no new)", len(full.Printers))
		}
	}()

	if a.printerCount() == 0 {
		log.Printf("INFO: no printers configured yet; run discovery or add manually. Jobs will be queued until a printer is available.")
	} else {
		log.Printf("Agent initialized with %d printer(s) (config + registry)", a.printerCount())
	}

	return a, nil
}

// ListPrinters returns the current discovered/configured printer inventory.
func (a *Agent) ListPrinters() []printer.DeviceInfo {
	infos, _ := printer.ListPrinters(a.cfg, a.registryPath)
	return infos
}

// Discover runs discovery and refreshes the local registry + printer map.
func (a *Agent) Discover() printer.DiscoveryResult {
	result := printer.Discover(a.cfg, a.registryPath)
	if len(result.Printers) > 0 {
		if merged, err := printer.UpsertRegistry(a.registryPath, result.Printers); err == nil {
			// Refresh in-memory printers with merged registry
			for _, di := range merged {
				if _, exists := a.getPrinter(di.ID); exists {
					continue
				}
				pc := config.PrinterConfig{
					ID:           di.ID,
					Name:         di.Name,
					Type:         di.ConnectionType,
					Endpoint:     di.Endpoint,
					Protocol:     di.Protocol,
					SpoolerName:  di.SpoolerName,
					PrinterType:  di.PrinterType,
					USBVID:       di.USBVID,
					USBPID:       di.USBPID,
					USBSerial:    di.USBSerial,
					Capabilities: di.Capabilities,
				}
				if p, err := printer.New(pc); err == nil {
					a.addPrinter(di.ID, p, pc)
				} else {
					log.Printf("WARNING: discovered printer %q (%s) not initialized: %v", di.ID, di.Name, err)
				}
			}
			result.Printers = merged
		}
	}
	log.Printf("Discovery completed: %d printers found", len(result.Printers))
	return result
}

// RegisterManual adds a manually configured printer (for when discovery cannot identify correctly).
func (a *Agent) RegisterManual(info printer.DeviceInfo) error {
	if info.ID != "" {
		if _, exists := a.getPrinter(info.ID); exists {
			return fmt.Errorf("printer ID %q already exists", info.ID)
		}
	}
	if info.ID == "" {
		info.ID = printer.StableIDForDevice(info)
	}
	if _, err := printer.RegisterManual(a.registryPath, info); err != nil {
		return err
	}
	pc := config.PrinterConfig{
		ID:          info.ID,
		Name:        info.Name,
		Type:        info.ConnectionType,
		Endpoint:    info.Endpoint,
		Protocol:    info.Protocol,
		SpoolerName: info.SpoolerName,
	}
	if info.ConnectionType == "spooler" && pc.SpoolerName == "" {
		pc.SpoolerName = info.SpoolerName
	}
	p, err := printer.New(pc)
	if err != nil {
		return err
	}
	if !a.addPrinter(info.ID, p, pc) {
		return fmt.Errorf("printer ID %q already exists", info.ID)
	}
	log.Printf("Manual printer registered: %s (%s)", info.ID, info.Name)
	return nil
}

// TestPrinter runs a real test print against the given printer ID.
func (a *Agent) TestPrinter(printerID string) error {
	return printer.TestPrinter(a.cfg, a.registryPath, printerID)
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

	log.Printf("Agent %s starting (ID: %s, %d printer(s) configured)", a.cfg.Agent.Name, a.cfg.Agent.ID, a.printerCount())

	// Crash recovery must run before any new delivery is accepted.
	a.recoverInterruptedJobs()

	go a.connectWebSocket(ctx)

	heartbeatTicker := time.NewTicker(30 * time.Second)
	pollTicker := time.NewTicker(10 * time.Second) // Fallback poll
	defer heartbeatTicker.Stop()
	defer pollTicker.Stop()

	// Send an immediate heartbeat/poll on startup instead of waiting a full tick.
	go a.sendHeartbeatGuarded()
	go a.pollJobsGuarded(ctx)

	// Counts poll ticks skipped because the WebSocket is connected.
	wsSafetyPollTicks := 0

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
			// Poll is the primary delivery path while the WebSocket is down.
			// While the socket IS up it still runs as a safety net every
			// wsSafetyPollEvery ticks: a job that was claimed for WS delivery
			// but never reached the agent (socket died between claim and
			// send, agent restarted, backlog overflow) is only recovered by
			// the poll endpoint's stale-claim reclaim. Without this the job
			// would sit claimed until the agent happened to disconnect.
			if a.getWSConn() == nil {
				wsSafetyPollTicks = 0
				go a.pollJobsGuarded(ctx)
			} else {
				wsSafetyPollTicks++
				if wsSafetyPollTicks >= wsSafetyPollEvery {
					wsSafetyPollTicks = 0
					go a.pollJobsGuarded(ctx)
				}
			}
		}
	}
}

// recoverInterruptedJobs reports jobs that were still physically printing when
// the previous agent process stopped.
//
// Their outcome is genuinely unknown (the printer may have printed everything,
// part of the document, or nothing), so the agent does NOT guess: it marks
// them terminal locally with queue.InterruptedMarker and tells the gateway the
// job failed with that explicit reason. Without this the row stayed 'printing'
// locally and the gateway only noticed after the 90s claim lease, then
// re-delivered the job and a duplicate page came out with nobody informed.
//
// This is honest at-least-once behaviour made visible — it is NOT exactly-once
// printing. Set agent.reprint_after_crash: false to stop the agent from
// automatically printing such a job again (see processJob).
func (a *Agent) recoverInterruptedJobs() {
	interrupted, err := a.queue.MarkInterrupted()
	if err != nil {
		log.Printf("WARNING: could not scan the local queue for interrupted jobs: %v", err)
	}
	for _, job := range interrupted {
		log.Printf(
			"WARNING: job %s on printer %s was still printing when the agent stopped. Physical output is UNKNOWN (full, partial or none). Reporting it as failed; reprint_after_crash=%v",
			job.ID, job.PrinterID, a.cfg.ReprintAfterCrashEnabled(),
		)
		a.updateJobStatus(job.ID, "failed", queue.InterruptedMarker+
			": the agent stopped while this job was printing; the physical output is unknown (full, partial or none)")
	}
	if len(interrupted) > 0 {
		log.Printf("Crash recovery: %d job(s) were interrupted mid-print and reported to the gateway", len(interrupted))
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

		var envelope map[string]interface{}
		if err := json.Unmarshal(message, &envelope); err != nil {
			log.Printf("Malformed WS message: %v", err)
			continue
		}

		job, ok := extractJobFromWSMessage(envelope)
		if !ok {
			log.Printf("Ignoring WS message without a print job: %v", envelope["type"])
			continue
		}

		jobID, _ := job["id"].(string)
		if jobID == "" {
			log.Printf("Ignoring WS job without an id")
			continue
		}

		// Acknowledge receipt immediately — before any printing. The ack means
		// "this agent has the job", never "the job printed"; the gateway only
		// records delivery from it. Duplicates are acked too (see dispatchJob),
		// so the gateway can distinguish a lost delivery from a duplicate one.
		if err := a.sendJobAck(jobID); err != nil {
			log.Printf("Job %s: failed to send job_ack: %v", jobID, err)
		}

		a.dispatchJob(ctx, job)
	}
}

// extractJobFromWSMessage understands both the current delivery envelope
//
//	{"type":"print_job","job":{...}}
//
// and the legacy bare-job message ({"id":...,"printerId":...}) so an agent
// still works against an older gateway build.
func extractJobFromWSMessage(msg map[string]interface{}) (map[string]interface{}, bool) {
	if msg == nil {
		return nil, false
	}
	switch t, _ := msg["type"].(string); t {
	case "print_job":
		if job, ok := msg["job"].(map[string]interface{}); ok {
			return job, true
		}
		// Envelope with flat aliases only.
		if _, ok := msg["id"].(string); ok {
			return msg, true
		}
		return nil, false
	case "":
		if _, ok := msg["id"].(string); ok {
			return msg, true
		}
		return nil, false
	default:
		return nil, false
	}
}

// sendJobAck writes {"type":"job_ack","jobId":"..."} back to the gateway.
func (a *Agent) sendJobAck(jobID string) error {
	conn := a.getWSConn()
	if conn == nil {
		return fmt.Errorf("no websocket connection")
	}
	payload, err := json.Marshal(map[string]string{"type": "job_ack", "jobId": jobID})
	if err != nil {
		return err
	}
	a.wsWriteMu.Lock()
	defer a.wsWriteMu.Unlock()
	if err := conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, payload)
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
// It now reports the full discovery model: connectionType, protocol,
// spooler_name, etc., so Gateway can store canonical printer registry and
// route jobs by branch/destination/documentType without relying on YAML.
func (a *Agent) printerStatusPayload() []map[string]interface{} {
	// Snapshot the printer map under the read lock: the async discovery
	// goroutine may add printers while heartbeats probe statuses.
	a.printersMu.RLock()
	ids := make([]string, 0, len(a.printers))
	for id := range a.printers {
		ids = append(ids, id)
	}
	printerByID := make(map[string]printer.Printer, len(a.printers))
	configByID := make(map[string]config.PrinterConfig, len(a.printerConfigs))
	for id, p := range a.printers {
		printerByID[id] = p
	}
	for id, pc := range a.printerConfigs {
		configByID[id] = pc
	}
	a.printersMu.RUnlock()
	sort.Strings(ids) // deterministic order aids gateway-side diffing

	statuses := make([]string, len(ids))
	var probeWg sync.WaitGroup
	probeWg.Add(len(ids))
	for i, id := range ids {
		go func(i int, pid string, p printer.Printer) {
			defer probeWg.Done()
			defer func() {
				if r := recover(); r != nil {
					log.Printf("Status probe panic for %s: %v", pid, r)
					statuses[i] = "error"
				}
			}()
			statuses[i] = p.Status()
		}(i, id, printerByID[id])
	}
	probeWg.Wait()

	result := make([]map[string]interface{}, 0, len(ids))
	for i, id := range ids {
		pc := configByID[id]
		nt := pc.NormalizedType()
		proto := pc.NormalizedProtocol()
		if proto == "" {
			proto = "raw"
		}
		pt := pc.PrinterType
		if pt == "" {
			pt = "unknown"
		}
		// Build payload with all required fields for Gateway inventory
		entry := map[string]interface{}{
			"id":             id,
			"name":           pc.Name,
			"displayName":    pc.Name,
			"type":           nt,
			"printerType":    pt,
			"connectionType": nt,
			"protocol":       proto,
			"status":         statuses[i],
			"enabled":        pc.IsEnabled(),
			"config":         endpointToConfig(pc),
		}
		// Include USB identifiers if present
		if pc.USBVID != "" {
			entry["usbVid"] = pc.USBVID
		}
		if pc.USBPID != "" {
			entry["usbPid"] = pc.USBPID
		}
		if pc.USBSerial != "" {
			entry["usbSerial"] = pc.USBSerial
		}
		if pc.SpoolerName != "" {
			entry["spoolerName"] = pc.SpoolerName
		}
		if pc.Endpoint != "" {
			entry["endpoint"] = pc.Endpoint
		}
		// Network address/port for network and IPP printers
		if nt == "network" || nt == "ipp" || nt == "ipps" {
			if host, portStr, err := net.SplitHostPort(pc.Endpoint); err == nil {
				entry["networkAddress"] = host
				if p, err := strconv.Atoi(portStr); err == nil {
					entry["port"] = p
				}
			} else {
				// Try IPP URL parsing
				lowerEP := strings.ToLower(pc.Endpoint)
				parseStr := pc.Endpoint
				if strings.HasPrefix(lowerEP, "ipp://") {
					parseStr = "http://" + pc.Endpoint[6:]
				} else if strings.HasPrefix(lowerEP, "ipps://") {
					parseStr = "https://" + pc.Endpoint[7:]
				}
				if u, err := url.Parse(parseStr); err == nil && u.Host != "" {
					entry["networkAddress"] = u.Hostname()
					if p := u.Port(); p != "" {
						if port, err := strconv.Atoi(p); err == nil {
							entry["port"] = port
						}
					} else {
						if strings.HasPrefix(lowerEP, "ipps://") || u.Scheme == "https" {
							entry["port"] = 631
						} else {
							entry["port"] = 631
						}
					}
				}
			}
		}
		// Capabilities: always report which document kinds this backend can
		// physically print, so the gateway routing layer can reject an
		// incompatible job (e.g. PDF to an ESC/POS byte stream) before it is
		// ever queued. An explicitly configured supported_protocols list is
		// left untouched.
		caps := make(map[string]interface{}, len(pc.Capabilities)+1)
		for k, v := range pc.Capabilities {
			caps[k] = v
		}
		if _, ok := caps["supported_protocols"]; !ok {
			if p, ok := printerByID[id]; ok && p != nil {
				caps["supported_protocols"] = printer.SupportedKinds(p)
			}
		}
		if len(caps) > 0 {
			entry["capabilities"] = caps
		}
		result = append(result, entry)
	}
	return result
}

// endpointToConfig normalizes the agent's local endpoint into the gateway's
// printer.config shape. Handles tcp, spooler, usb, ipp and includes USB metadata.
func endpointToConfig(pc config.PrinterConfig) map[string]interface{} {
	proto := pc.NormalizedProtocol()
	if proto == "" {
		proto = "raw"
	}
	cfgMap := map[string]interface{}{"protocol": proto}
	nt := pc.NormalizedType()
	switch nt {
	case "network":
		host, portStr, err := net.SplitHostPort(pc.Endpoint)
		if err == nil {
			cfgMap["ip"] = host
			if port, err := strconv.Atoi(portStr); err == nil {
				cfgMap["port"] = port
			}
		} else {
			cfgMap["ip"] = pc.Endpoint
		}
	case "spooler":
		spoolerName := pc.SpoolerName
		if spoolerName == "" {
			spoolerName = pc.Endpoint
		}
		cfgMap["spooler_name"] = spoolerName
		cfgMap["address"] = spoolerName
		// Include underlying USB info if spooler is USB-backed
		if pc.USBVID != "" {
			cfgMap["vid"] = pc.USBVID
			cfgMap["usb_vid"] = pc.USBVID
		}
		if pc.USBPID != "" {
			cfgMap["pid"] = pc.USBPID
			cfgMap["usb_pid"] = pc.USBPID
		}
		if pc.USBSerial != "" {
			cfgMap["serial"] = pc.USBSerial
			cfgMap["usb_serial"] = pc.USBSerial
		}
	case "usb":
		cfgMap["address"] = pc.Endpoint
		if pc.SpoolerName != "" {
			cfgMap["spooler_name"] = pc.SpoolerName
		}
		if pc.USBVID != "" {
			cfgMap["vid"] = pc.USBVID
			cfgMap["usb_vid"] = pc.USBVID
		}
		if pc.USBPID != "" {
			cfgMap["pid"] = pc.USBPID
			cfgMap["usb_pid"] = pc.USBPID
		}
		if pc.USBSerial != "" {
			cfgMap["serial"] = pc.USBSerial
			cfgMap["usb_serial"] = pc.USBSerial
		}
		// Add diagnostic if direct USB without spooler
		if pc.SpoolerName == "" {
			cfgMap["diagnostic"] = "USB device requires Windows spooler queue for printing"
		}
	case "ipp", "ipps":
		cfgMap["address"] = pc.Endpoint
		cfgMap["ipp_url"] = pc.Endpoint
		// Try to extract host/port from URL for gateway
		lowerEP := strings.ToLower(pc.Endpoint)
		parseStr := pc.Endpoint
		if strings.HasPrefix(lowerEP, "ipp://") {
			parseStr = "http://" + pc.Endpoint[6:]
		} else if strings.HasPrefix(lowerEP, "ipps://") {
			parseStr = "https://" + pc.Endpoint[7:]
		}
		if u, err := url.Parse(parseStr); err == nil && u.Host != "" {
			cfgMap["ip"] = u.Hostname()
			if p := u.Port(); p != "" {
				if port, err := strconv.Atoi(p); err == nil {
					cfgMap["port"] = port
				}
			} else {
				cfgMap["port"] = 631
			}
			cfgMap["host"] = u.Host
		} else {
			cfgMap["ip"] = pc.Endpoint
		}
	default:
		cfgMap["address"] = pc.Endpoint
	}
	// Include capabilities if present
	if pc.Capabilities != nil {
		for k, v := range pc.Capabilities {
			cfgMap[k] = v
		}
	}
	// Legacy alias
	if pc.PrinterType != "" {
		cfgMap["printer_type"] = pc.PrinterType
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

	// Local idempotency: a job that already printed successfully on THIS agent
	// is never printed again, no matter how often it is delivered. The stored
	// terminal result is re-reported so a duplicate delivery cannot leave the
	// gateway waiting for a status that will never come.
	//
	// A locally FAILED job is deliberately retryable: the gateway only
	// re-delivers it after an explicit reclaim that increments the retry
	// counter, and that retry (e.g. printer was briefly offline) must be
	// allowed to run. The retry budget lives in the gateway, not here.
	if _, localStatus, found, err := a.queue.Get(jobID); err != nil {
		log.Printf("Job %s: local queue lookup failed (continuing): %v", jobID, err)
	} else if found && localStatus == "success" {
		log.Printf("Job %s already completed locally (success). Re-reporting terminal result instead of printing again.", jobID)
		a.updateJobStatus(jobID, "success", "")
		return
	} else if found && a.queue.WasInterrupted(jobID) && !a.cfg.ReprintAfterCrashEnabled() {
		// This job was already at the printer when the agent stopped, so it
		// may have produced paper. With reprint_after_crash disabled the agent
		// refuses to print it a second time and re-reports the interruption
		// instead of silently duplicating the document.
		reason := queue.InterruptedMarker + ": refusing to reprint after a crash (agent.reprint_after_crash=false); the previous attempt may have produced output"
		log.Printf("Job %s: %s", jobID, reason)
		a.updateJobStatus(jobID, "failed", reason)
		return
	}

	p, ok := a.getPrinter(printerID)
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

	// Capability gate BEFORE anything is written anywhere: a printer that
	// cannot render this document kind (e.g. a PDF sent to an ESC/POS byte
	// stream) fails the job with CAPABILITY_MISMATCH instead of emitting
	// unrenderable bytes. The gateway routing layer performs the same check;
	// this is the authoritative, device-side enforcement.
	kind := string(pl.Type)
	if !printer.SupportsKind(p, kind) {
		reason := fmt.Sprintf("CAPABILITY_MISMATCH: printer %s cannot print %s payloads", printerID, kind)
		log.Printf("Job %s rejected: %s", jobID, reason)
		a.updateJobStatus(jobID, "failed", reason)
		return
	}

	// Per-printer serialization: two jobs for the same printer never run concurrently.
	// The lock is held ONLY around the physical print call and local queue
	// bookkeeping. Gateway status callbacks (network I/O) are done outside the
	// critical section so a slow/unresponsive gateway never blocks other jobs
	// queued for the same printer.
	lock := a.getPrinterLock(printerID)
	lock.Lock()
	// Re-check idempotency now that we hold the lock, in case a racing
	// delivery (WS + poll fallback both firing) got here first.
	if a.queue.IsProcessed(jobID) {
		lock.Unlock()
		log.Printf("Job %s was already processed while waiting for the printer lock. Skipping.", jobID)
		return
	}

	log.Printf("Printing job %s on printer %s (%d bytes, type=%s, path=%s)", jobID, printerID, len(pl.Data), pl.Type, printer.NormalizeKind(kind))

	if err := a.queue.Push(jobID, printerID, pl.Data); err != nil {
		log.Printf("Job %s: failed to persist to local durable queue (continuing anyway): %v", jobID, err)
	}
	a.queue.UpdateStatus(jobID, "printing")
	lock.Unlock()

	// Report printing outside the per-printer lock (network I/O must not hold mutex)
	a.updateJobStatus(jobID, "printing", "")

	printCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	// Physical print is serialized per printer; re-check dedup before printing
	// in case the same jobId was already completed while we were reporting
	// "printing" or waiting for the printer lock. Local queue updates are kept
	// inside the critical section so a waiter sees the terminal state.
	lock.Lock()
	if a.queue.IsProcessed(jobID) {
		lock.Unlock()
		log.Printf("Job %s was already processed while waiting for printer %s. Skipping duplicate print.", jobID, printerID)
		return
	}
	// Kind-aware dispatch: PDF goes through the PDF pipeline (validated,
	// written to a secure temp file, rendered by the printer driver), raw and
	// ESC/POS keep their byte-stream paths. A PDF is never re-labelled as RAW.
	printErr := printer.PrintDocument(printCtx, p, printer.Document{Kind: kind, Data: pl.Data, JobID: jobID})
	if printErr != nil {
		_ = a.queue.UpdateStatusWithError(jobID, "failed", printErr.Error())
	} else {
		_ = a.queue.UpdateStatus(jobID, "success")
	}
	lock.Unlock()

	if printErr != nil {
		log.Printf("Job %s FAILED on printer %s: %v", jobID, printerID, printErr)
		a.updateJobStatus(jobID, "failed", printErr.Error())
		return
	}

	log.Printf("Job %s: payload transmitted successfully to printer %s", jobID, printerID)
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
