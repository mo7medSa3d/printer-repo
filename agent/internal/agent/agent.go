package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	"sync/atomic"
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

// printDocumentTimeout bounds a single physical print as a function of the
// payload size. Base 2m covers dial + spooler setup + a small receipt; each
// megabyte adds 30s, which is generous even for a 9600-baud thermal
// (~1.2KB/s). This is a HARD cap against a permanently stuck device — the
// transport applies tighter per-write stall detection — and it is sized so a
// legitimate 5MB job (~4m) completes well inside the window.
func printDocumentTimeout(payloadBytes int) time.Duration {
	const base = 2 * time.Minute
	const perMB = 30 * time.Second
	mb := int64(payloadBytes) / (1024 * 1024)
	if mb < 0 {
		mb = 0
	}
	return base + time.Duration(mb)*perMB
}

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
	// inFlightTokens carries the claim token of each in-flight delivery
	// attempt, under the same mutex. Heartbeat keep-alives echo the token
	// so the gateway can fence the lease refresh to the live claim.
	inFlightTokens map[string]string
	// inFlightReceived records when each delivery was accepted, under the
	// same mutex. It bounds the physical-dispatch race: the gateway sweep
	// can only reclaim a claim observed stale for a full lease window, so
	// a transport failure inside that window cannot be masking a
	// reassignment (see authorizeDispatchAfterReportFailure).
	inFlightReceived map[string]time.Time
	inFlightMu       sync.Mutex
	wg               sync.WaitGroup

	// Guards making heartbeat/poll ticks non-reentrant. A slow tick (offline
	// printers probing at 2s, slow gateway) must never let ticks pile up.
	hbMu   sync.Mutex
	pollMu sync.Mutex

	// discoverySem bounds concurrent gateway-directed discovery sessions to
	// one: each session is a full bounded LAN scan (30s bound), and piling
	// them up per pending session (as an unbounded go-per-session did)
	// would fork a scan per session. Pending sessions expire on the
	// gateway in 60s, so the next poll tick simply picks the rest up.
	discoverySem chan struct{}

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

	// Single-flight probe state per printer: prevents unbounded goroutine accumulation
	// when Win32 Spooler or network RPC calls block.
	probeStateMu sync.Mutex
	probeStates  map[string]*printerProbeState
}

type printerProbeState struct {
	running      atomic.Bool
	lastStatusMu sync.Mutex
	lastStatus   string
}

func (p *printerProbeState) get() string {
	p.lastStatusMu.Lock()
	defer p.lastStatusMu.Unlock()
	return p.lastStatus
}

func (p *printerProbeState) set(status string) {
	p.lastStatusMu.Lock()
	defer p.lastStatusMu.Unlock()
	p.lastStatus = status
}

func (a *Agent) probeLastStatus(printerID string) string {
	return a.getProbeState(printerID).get()
}

func (a *Agent) setProbeLastStatus(printerID, status string) {
	a.getProbeState(printerID).set(status)
}

func (a *Agent) getProbeState(printerID string) *printerProbeState {
	a.probeStateMu.Lock()
	defer a.probeStateMu.Unlock()
	if a.probeStates == nil {
		a.probeStates = make(map[string]*printerProbeState)
	}
	st, exists := a.probeStates[printerID]
	if !exists {
		st = &printerProbeState{lastStatus: "unknown"}
		a.probeStates[printerID] = st
	}
	return st
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
		cfg:              cfg,
		configPath:       configPath,
		registryPath:     registryPath,
		client:           &http.Client{Timeout: 15 * time.Second},
		printers:         make(map[string]printer.Printer),
		printerConfigs:   make(map[string]config.PrinterConfig),
		queue:            q,
		jobLocks:         make(map[string]*sync.Mutex),
		execSem:          make(chan struct{}, maxConcurrentJobs),
		pendingSlots:     make(chan struct{}, maxPendingJobs),
		inFlight:         make(map[string]struct{}),
		inFlightTokens:   make(map[string]string),
		inFlightReceived: make(map[string]time.Time),
		shutdownCh:       make(chan struct{}),
		discoverySem:     make(chan struct{}, 1),
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

func (a *Agent) runInitialAsyncDiscovery(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[discovery] async full discovery panic: %v", r)
		}
	}()

	// Small delay to let gateway communication start first
	select {
	case <-ctx.Done():
		return
	case <-time.After(2 * time.Second):
	}

	select {
	case <-ctx.Done():
		return
	default:
	}

	log.Printf("[discovery] starting async full discovery (network+USB)")
	full := printer.DiscoverWithContext(ctx, a.cfg, a.registryPath)
	if len(full.Errors) > 0 {
		for _, e := range full.Errors {
			log.Printf("discovery warning: %s", e)
		}
	}

	select {
	case <-ctx.Done():
		return
	default:
	}

	if len(full.Printers) > 0 {
		if merged, err := printer.UpsertRegistry(a.registryPath, full.Printers); err == nil {
			for _, di := range merged {
				select {
				case <-ctx.Done():
					return
				default:
				}
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
	}
	log.Printf("[discovery] async discovery completed: %d printers", len(full.Printers))
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

	var discoveryWg sync.WaitGroup
	discoveryWg.Add(1)
	go func() {
		defer discoveryWg.Done()
		a.runInitialAsyncDiscovery(ctx)
	}()

	heartbeatTicker := time.NewTicker(30 * time.Second)
	pollTicker := time.NewTicker(10 * time.Second) // Fallback poll
	discoveryTicker := time.NewTicker(30 * time.Second)
	defer heartbeatTicker.Stop()
	defer pollTicker.Stop()
	defer discoveryTicker.Stop()

	// Send an immediate heartbeat/poll on startup instead of waiting a full tick.
	go a.sendHeartbeatGuarded()
	go a.pollJobsGuarded(ctx)
	go a.pollDiscovery(ctx)

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
			discoveryWg.Wait()
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
		case <-discoveryTicker.C:
			go a.pollDiscovery(ctx)
		}
	}
}

// recoverInterruptedJobs handles jobs that were still physically printing when
// the previous agent process stopped.
//
// Their outcome is genuinely unknown (the printer may have printed everything,
// part of the document, or nothing), so the agent does NOT guess. The local
// row is marked terminal with queue.InterruptedMarker in both cases; what
// differs is what is told to the gateway, per agent.reprint_after_crash:
//
//   - true:  report NOTHING. The gateway's lease handling treats the delivered
//     but unreported claim as an unknown outcome (terminal, manual reprint
//     only). If the SAME job id is ever delivered again (only possible for
//     claims that never showed delivery evidence), the WasInterrupted gate
//     below allows exactly one more physical attempt - honest at-least-once
//     behaviour that may duplicate paper.
//   - false: report the job failed with an explicit reason so the gateway
//     stops immediately and the document is never silently reprinted.
//
// Either way this is NOT exactly-once printing; the physical outcome of the
// interrupted attempt is unknown and that is what gets recorded.
func (a *Agent) recoverInterruptedJobs() {
	interrupted, err := a.queue.MarkInterrupted()
	if err != nil {
		log.Printf("WARNING: could not scan the local queue for interrupted jobs: %v", err)
	}
	reprint := a.cfg.ReprintAfterCrashEnabled()
	for _, job := range interrupted {
		if reprint {
			log.Printf(
				"WARNING: job %s on printer %s was still printing when the agent stopped. Physical output is UNKNOWN (full, partial or none). reprint_after_crash=true: leaving the job to the gateway lease so it can be redelivered and reprinted.",
				job.ID, job.PrinterID,
			)
			continue
		}
		log.Printf(
			"WARNING: job %s on printer %s was still printing when the agent stopped. Physical output is UNKNOWN (full, partial or none). Reporting it as failed; reprint_after_crash=%v",
			job.ID, job.PrinterID, reprint,
		)
		a.updateJobStatus(job.ID, "failed", queue.InterruptedMarker+
			": the agent stopped while this job was printing; the physical output is unknown (full, partial or none)", job.ClaimToken)
	}
	if len(interrupted) > 0 {
		log.Printf("Crash recovery: %d job(s) were interrupted mid-print (reprint_after_crash=%v)", len(interrupted), reprint)
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

// wsIdleTimeout must exceed the server's 30s ping interval with margin. No
// frame for longer than this means the socket is half-open (NAT/LB idle drop
// is routine on POS connections) and the read loop must fail so the poll
// fallback takes over — otherwise job delivery silently degrades forever.
const wsIdleTimeout = 90 * time.Second

// maxWSFrameBytes bounds one inbound frame: the gateway's own message cap is
// 64KB for agent->server traffic, while server->agent job envelopes carry a
// base64 payload of up to ~5 MiB. Anything larger is hostile or corrupt.
const maxWSFrameBytes = 8 << 20

func (a *Agent) handleWSMessages(ctx context.Context) error {
	conn := a.getWSConn()
	if conn == nil {
		return fmt.Errorf("connection closed")
	}
	conn.SetReadLimit(maxWSFrameBytes)
	_ = conn.SetReadDeadline(time.Now().Add(wsIdleTimeout))
	conn.SetPingHandler(func(data string) error {
		_ = conn.SetReadDeadline(time.Now().Add(wsIdleTimeout))
		// WriteControl has its own internal control-frame mutex and may
		// interleave with wsWriteMu-serialized data writes, as documented.
		return conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(10*time.Second))
	})
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(wsIdleTimeout))
	})
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
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
			log.Printf("Ignoring WS job without an id (type=%v)", envelope["type"])
			continue
		}
		// Validate the delivery is addressed to THIS agent and is a live
		// claim. A replayed or mis-routed frame (gateway restart, backlog
		// re-push, stale instance) must never print.
		if agentID, _ := job["agentId"].(string); agentID != "" && agentID != a.cfg.Agent.ID {
			log.Printf("Job %s: WS delivery addressed to a different agent; ignoring", jobID)
			continue
		}
		if status, _ := job["status"].(string); status != "" && status != "claimed" {
			log.Printf("Job %s: WS delivery carries non-claimed status %q; ignoring", jobID, status)
			continue
		}

		// Acknowledge receipt immediately — before any printing. The ack means
		// "this agent has the job", never "the job printed"; the gateway only
		// records delivery from it. Duplicates are acked too (see dispatchJob),
		// so the gateway can distinguish a lost delivery from a duplicate one.
		if err := a.sendJobAck(jobID, jobClaimToken(job)); err != nil {
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

// sendJobAck writes {"type":"job_ack","jobId":"...","claimToken":"..."} back
// to the gateway. The claim token attributes the ack to THIS delivery attempt
// so the gateway's fenced predicates can reject a superseded frame.
func (a *Agent) sendJobAck(jobID, claimToken string) error {
	conn := a.getWSConn()
	if conn == nil {
		return fmt.Errorf("no websocket connection")
	}
	ack := map[string]string{"type": "job_ack", "jobId": jobID}
	if claimToken != "" {
		ack["claimToken"] = claimToken
	}
	payload, err := json.Marshal(ack)
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
		// The agent is stopping. Report a FENCED pre-execution rejection so
		// the gateway can re-queue the job without burning attempts. If the
		// PATCH fails (network down), the undelivered-claim sweep remains
		// the safe backstop: it only re-queues claims that never showed
		// delivery evidence.
		a.rejectJob(jobID, jobClaimToken(job), "agent_shutting_down")
		return
	default:
	}
	if _, dup := a.inFlight[jobID]; dup {
		a.inFlightMu.Unlock()
		log.Printf("Job %s is already in flight; duplicate delivery ignored.", jobID)
		return
	}
	a.inFlight[jobID] = struct{}{}
	if a.inFlightTokens == nil {
		a.inFlightTokens = make(map[string]string)
	}
	if a.inFlightReceived == nil {
		a.inFlightReceived = make(map[string]time.Time)
	}
	a.inFlightTokens[jobID] = jobClaimToken(job)
	a.inFlightReceived[jobID] = time.Now()
	a.wg.Add(1)
	a.inFlightMu.Unlock()

	select {
	case a.pendingSlots <- struct{}{}:
	default:
		a.forgetJob(jobID)
		a.wg.Done() // undo the reservation; no goroutine will run
		log.Printf("Job %s dropped: %d jobs already in flight; handing it back to the gateway queue (pending_full).", jobID, maxPendingJobs)
		// Tell the gateway NOW so the job is requeued immediately instead of
		// sitting 'claimed' for the 90s lease. The gateway refunds the
		// delivery-attempt charge for this provably pre-execution return
		// (zero bytes sent) and consumes one retry instead, so a saturated
		// agent holding a big backlog cannot burn jobs into a delivery-budget
		// failure (see the reject gate in src/app/api/agent/jobs).
		// Best-effort: the lease reclaim is the backstop if this PATCH fails.
		a.rejectJob(jobID, jobClaimToken(job), "pending_full")
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
			// Shutdown (or cancellation) reached this backlog job before an
			// execution slot freed up: nothing was dispatched, so it is
			// provably pre-execution. Tell the gateway (fenced rejection,
			// not counted against retries) instead of silently dropping the
			// job and waiting out the 90s lease reclaim.
			a.rejectJob(jobID, jobClaimToken(job), "agent_shutting_down")
			return
		}

		a.processJob(ctx, job)
	}()
}

// staleClaimSafetyWindow mirrors the gateway's STALE_CLAIM_SECONDS
// (src/lib/job-maintenance.ts). The sweep only requeues a claim observed
// stale for a full window past its claim commit, so a delivery received
// less than a window ago cannot have been reclaimed yet. Both sides must
// be changed together if the lease ever changes.
const staleClaimSafetyWindow = 90 * time.Second

// authorizeDispatchAfterReportFailure decides whether physical dispatch may
// proceed after the claimed->printing report did NOT come back accepted.
//
//   - Fence rejection (ErrStaleClaim) or any other explicit gateway
//     rejection (ErrTransitionRejected): the gateway evaluated our claim
//     and refused it. Another attempt may own the job. HARD STOP.
//   - Transport failure: the gateway said nothing. Dispatch may proceed
//     ONLY if ownership is still provable: the delivery was received less
//     than a full lease window ago (no reclaim could have completed) and
//     the job TTL has not passed while we held it. Otherwise the job may
//     already belong to a reclaimed attempt: HARD STOP.
//   - Unknown receipt time (zero): freshness cannot be proven. HARD STOP.
//
// The returned reason is recorded in the aborted ledger row for forensics.
func authorizeDispatchAfterReportFailure(receivedAt time.Time, expiresAt time.Time, hasExpiry bool, now time.Time, reportErr error) (bool, string) {
	if errors.Is(reportErr, ErrStaleClaim) {
		return false, "claim fence rejected by gateway"
	}
	if errors.Is(reportErr, ErrTransitionRejected) {
		return false, "gateway explicitly rejected the printing transition"
	}
	if receivedAt.IsZero() {
		return false, "delivery receipt time unknown; ownership freshness unprovable"
	}
	if hasExpiry && !now.Before(expiresAt) {
		return false, "job TTL elapsed while held locally"
	}
	if now.Sub(receivedAt) >= staleClaimSafetyWindow {
		return false, "delivery older than the claim-lease window; a reclaim may have completed"
	}
	return true, ""
}

// authorizeDispatchAfterReportFailure is the processJob-facing wrapper that
// reads the delivery receipt time tracked at dispatch acceptance.
func (a *Agent) authorizeDispatchAfterReportFailure(jobID, expiresAtStr string, reportErr error) (bool, string) {
	var expiresAt time.Time
	hasExpiry := false
	if expiresAtStr != "" {
		if parsed, err := time.Parse(time.RFC3339, expiresAtStr); err == nil {
			expiresAt, hasExpiry = parsed, true
		}
	}
	return authorizeDispatchAfterReportFailure(a.deliveryReceivedAt(jobID), expiresAt, hasExpiry, time.Now(), reportErr)
}

func jobClaimToken(job map[string]interface{}) string {
	if token, ok := job["claimToken"].(string); ok {
		return token
	}
	return ""
}

func (a *Agent) forgetJob(id string) {
	a.inFlightMu.Lock()
	delete(a.inFlight, id)
	delete(a.inFlightTokens, id)
	delete(a.inFlightReceived, id)
	a.inFlightMu.Unlock()
}

func (a *Agent) deliveryReceivedAt(jobID string) time.Time {
	a.inFlightMu.Lock()
	defer a.inFlightMu.Unlock()
	return a.inFlightReceived[jobID]
}

// inFlightJobIDs returns up to limit ids of jobs currently held by the
// executor (waiting for an execution slot, running, or at the printer).
// Used for the heartbeat keep-alive (gateway print-lease extension).
// Each entry carries the delivery attempt's claim token: the gateway
// refreshes a lease ONLY when (jobId, claimToken) still matches the live
// claim, so a stale worker's heartbeat can never extend a reclaimed lease.
func (a *Agent) inFlightJobIDs(limit int) []map[string]string {
	if limit <= 0 {
		return nil
	}
	a.inFlightMu.Lock()
	defer a.inFlightMu.Unlock()
	if len(a.inFlight) == 0 {
		return nil
	}
	ids := make([]map[string]string, 0, len(a.inFlight))
	for id := range a.inFlight {
		ids = append(ids, map[string]string{"jobId": id, "claimToken": a.inFlightTokens[id]})
		if len(ids) >= limit {
			break
		}
	}
	return ids
}

// rejectJob hands a claimed job back to the gateway queue because the local
// executor is saturated (pendingSlots full). This is distinct from a real
// print failure: the agent is healthy, it just cannot accept the job right
// now. The gateway requeues it WITHOUT incrementing the retry budget, so a
// temporarily overloaded agent never drives a healthy backlog into
// 'exceeded max retries'. Best-effort — the gateway's 90s claim-lease
// reclaim remains the backstop if this request fails or races.
func (a *Agent) rejectJob(jobID, token, reason string) {
	reqURL := fmt.Sprintf("%s/api/agent/jobs", a.cfg.Server.URL)
	body := map[string]interface{}{
		// status "queued" + an explicit pre-execution reason is the
		// gateway's fenced rejection gate (claimed -> queued without
		// burning retries). The claim token proves WHICH attempt is
		// rejecting; a superseded claim cannot disturb the new one.
		"jobId":  jobID,
		"status": "queued",
		"reason": reason,
	}
	if token != "" {
		body["claimToken"] = token
	}
	resp, err := a.doAuthorizedRequest("PATCH", reqURL, body)
	if err != nil {
		log.Printf("Job %s: failed to report pending-full rejection: %v (claim lease remains the backstop)", jobID, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		log.Printf("Job %s: server rejected the pending-full rejection (%d): %s", jobID, resp.StatusCode, string(respBody))
	}
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
// deviceFacts returns the declared transport facts for one configured
// printer (protocol + explicit capability list) used by the precise
// payload/device capability gate.
func (a *Agent) deviceFacts(printerID string) (printer.TransportFacts, bool) {
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()
	pc, ok := a.printerConfigs[printerID]
	if !ok {
		return printer.TransportFacts{}, false
	}
	proto, err := pc.NormalizedProtocol()
	family := proto
	if err != nil {
		family = "unknown"
	}
	var caps []string
	if explicit, ok := pc.Capabilities["supported_protocols"].([]interface{}); ok {
		for _, v := range explicit {
			if str, ok := v.(string); ok {
				caps = append(caps, strings.ToLower(strings.TrimSpace(str)))
			}
		}
	} else if explicit, ok := pc.Capabilities["supported_protocols"].([]string); ok {
		caps = explicit
	}
	return printer.TransportFacts{
		Protocol:          family,
		Connection:        pc.NormalizedType(),
		SupportedProtocol: caps,
	}, true
}

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

	const maxReportedPrinters = 50
	if len(ids) > maxReportedPrinters {
		ids = ids[:maxReportedPrinters]
	}

	statuses := make([]string, len(ids))
	// Probe results flow back through a channel and are applied ONLY by this
	// goroutine; the probe goroutines never write `statuses` or `lastStatus`
	// concurrently (that was a data race - the 2s batch timeout could expire
	// while orphaned probes were still assigning their results).
	type probeResult struct {
		idx    int
		status string
	}
	results := make(chan probeResult, len(ids))
	probed := make(map[int]bool, len(ids))
	var probeWg sync.WaitGroup
	for i, id := range ids {
		state := a.getProbeState(id)
		if !state.running.CompareAndSwap(false, true) {
			// A previous probe is still running in the OS/RPC driver!
			// Do NOT spawn another goroutine. Reuse the last known status
			// (written under probeStateMu by whoever set it).
			statuses[i] = a.probeLastStatus(id)
			probed[i] = true
			continue
		}

		probeWg.Add(1)
		go func(i int, pid string, p printer.Printer, st *printerProbeState) {
			defer probeWg.Done()
			defer st.running.Store(false)
			status := "error"
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("Status probe panic for %s: %v", pid, r)
					}
				}()
				status = p.Status()
			}()
			a.setProbeLastStatus(pid, status)
			results <- probeResult{idx: i, status: status}
		}(i, id, printerByID[id], state)
	}

	probeDone := make(chan struct{})
	go func() {
		probeWg.Wait()
		close(probeDone)
	}()

	deadline := time.After(2 * time.Second)
collect:
	for {
		select {
		case res := <-results:
			statuses[res.idx] = res.status
			probed[res.idx] = true
		case <-probeDone:
			break collect
		case <-deadline:
			log.Printf("WARNING: Printer status probe batch timed out after 2s; proceeding with available statuses")
			break collect
		}
	}
	for i, id := range ids {
		if !probed[i] {
			statuses[i] = "spooler_rpc_unresponsive"
			a.setProbeLastStatus(id, "spooler_rpc_unresponsive")
		}
	}

	result := make([]map[string]interface{}, 0, len(ids))
	for i, id := range ids {
		pc := configByID[id]
		nt := pc.NormalizedType()
		// An undeclared protocol reports honestly as "unknown" (never a
		// default "raw"); the gateway capability model will not route to it.
		proto := pc.NormalizedProtocolOrUnknown()
		deviceClass := pc.PrinterType
		if deviceClass == "" {
			deviceClass = "unknown"
		}
		printerType := "physical"
		if deviceClass == "virtual" {
			printerType = "virtual"
			deviceClass = "unknown"
		}
		// Build payload with all required fields for Gateway inventory
		entry := map[string]interface{}{
			"id":             id,
			"name":           pc.Name,
			"displayName":    pc.Name,
			"printerType":    printerType,
			"deviceClass":    deviceClass,
			"connectionType": nt,
			"protocol":       proto,
			"status":         statuses[i],
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
						entry["port"] = 631
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
			// Derive the honest protocol list from the declared transport
			// (mirrors the canonical capability table); never invent
			// cross-protocol compatibility.
			facts, _ := a.deviceFacts(id)
			caps["supported_protocols"] = printer.SupportedProtocolsForDevice(facts)
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
	proto := pc.NormalizedProtocolOrUnknown()
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
	// Include capabilities if present. Reserved identity keys declared on
	// the printer config must never be overwritten by a capability bag.
	if pc.Capabilities != nil {
		for k, v := range pc.Capabilities {
			switch k {
			case "protocol", "address", "ip", "port", "printer_type":
				continue
			}
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
	// Print-lease keep-alive: report every (jobId, claimToken) pair this
	// agent currently holds (accepted + executing + physically printing).
	// While this agent is alive and working those jobs, the gateway keeps
	// their updated_at fresh, so a legitimately long print (or a job
	// waiting behind the per-printer serialization lock) is never
	// force-failed by the stale-printing sweep. A dead agent stops
	// heartbeating and its jobs time out exactly as before. Capped: the
	// gateway accepts at most 64.
	if ids := a.inFlightJobIDs(64); len(ids) > 0 {
		payload["keepAliveJobIds"] = ids
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
	claimToken := jobClaimToken(job)

	if jobID == "" || printerID == "" {
		// Never log the job map: it can embed the full print payload
		// (customer names, amounts). Log only the offending field names.
		missing := "id"
		if jobID != "" {
			missing = "printerId"
		}
		log.Printf("Received malformed job (missing %s, job present: %v); ignoring", missing, job != nil)
		return
	}

	if expiresAtStr != "" {
		if expiresAt, err := time.Parse(time.RFC3339, expiresAtStr); err == nil {
			if time.Now().UTC().After(expiresAt.UTC()) {
				log.Printf("Job %s expired before agent processing. Skipping.", jobID)
				a.updateJobStatus(jobID, "expired", "TTL exceeded before agent processing", claimToken)
				return
			}
		}
	}

	// Local idempotency: a job that already printed successfully on THIS
	// agent is never printed again, no matter how often it is delivered. The
	// stored terminal result is re-reported with the CURRENT delivery's
	// claim token so it passes the gateway's fencing predicate.
	//
	// A locally FAILED job with a PROVABLE not-printed outcome is retryable
	// (the gateway only re-delivers after a fenced reclaim that increments
	// its retry budget). A locally failed job whose outcome is UNKNOWN
	// (partial delivery, crash mid-print) is NEVER reprinted unless the
	// operator explicitly enabled reprint_after_crash (documented, opt-in
	// at-least-once behavior).
	if _, localStatus, found, err := a.queue.Get(jobID); err != nil {
		// The local ledger is the evidence base for all duplicate-print
		// protection. If it cannot be read we cannot prove this job has not
		// printed; refuse before dispatch (no bytes sent, safe retry).
		log.Printf("Job %s: local queue lookup failed; refusing dispatch: %v", jobID, err)
		// Fenced pre-execution return (never dispatched, zero bytes sent):
		// the gateway requeues without burning the retry budget.
		a.rejectJob(jobID, claimToken, "ledger_unavailable")
		return
	} else if found && localStatus == "success" {
		log.Printf("Job %s already completed locally (success). Re-reporting terminal result instead of printing again.", jobID)
		a.updateJobStatus(jobID, "success", "", claimToken)
		return
	} else if found && a.queue.WasOutcomeUnknown(jobID) && !a.cfg.ReprintAfterCrashEnabled() {
		// This job already reached the printer in a previous attempt, so it
		// may have produced paper. With reprint_after_crash disabled the
		// agent refuses to print it a second time and re-reports the
		// unknown outcome instead of silently duplicating the document.
		// The LOCAL history is echoed verbatim (crash marker stays a crash
		// marker; partial delivery stays a partial-delivery marker).
		marker := "UNKNOWN_PARTIAL_DELIVERY"
		if a.queue.WasInterrupted(jobID) {
			marker = queue.InterruptedMarker
		}
		reason := marker + ": refusing to reprint a job whose previous attempt had an unknown outcome (agent.reprint_after_crash=false); the earlier delivery may have produced output"
		log.Printf("Job %s: %s", jobID, reason)
		a.updateJobStatus(jobID, "failed", reason, claimToken)
		return
	}

	p, ok := a.getPrinter(printerID)
	if !ok {
		log.Printf("Job %s references printer %s which is not configured on this agent", jobID, printerID)
		a.updateJobStatus(jobID, "failed", fmt.Sprintf("printer %s is not configured on this agent", printerID), claimToken)
		return
	}

	pl, err := payload.Parse(job["payload"])
	if err != nil {
		log.Printf("Job %s has an invalid payload: %v", jobID, err)
		a.updateJobStatus(jobID, "failed", fmt.Sprintf("invalid payload: %v", err), claimToken)
		return
	}

	// Capability gate BEFORE anything is written anywhere. Two layers, both
	// pre-dispatch (failure here never touches hardware):
	//  1. Transport rendering capability (can this backend produce this
	//     document kind at all).
	//  2. The canonical payload-protocol x device-protocol table
	//     (capability.go, mirroring src/lib/routing.ts). A zpl payload must
	//     hit a zpl-declared device; a "raw" device is a byte sink, NOT a
	//     protocol wildcard.
	kind := string(pl.Type)
	if !printer.SupportsKind(p, kind) {
		reason := fmt.Sprintf("CAPABILITY_MISMATCH: printer %s cannot print %s payloads", printerID, kind)
		log.Printf("Job %s rejected: %s", jobID, reason)
		a.updateJobStatus(jobID, "failed", reason, claimToken)
		return
	}
	facts, factsOK := a.deviceFacts(printerID)
	if !factsOK {
		reason := fmt.Sprintf("CAPABILITY_MISMATCH: printer %s has no declared device facts on this agent", printerID)
		log.Printf("Job %s rejected: %s", jobID, reason)
		a.updateJobStatus(jobID, "failed", reason, claimToken)
		return
	}
	if compatible, why := printer.PayloadCompatibleForDevice(kind, pl.Protocol, facts); !compatible {
		reason := fmt.Sprintf("CAPABILITY_MISMATCH: %s", why)
		log.Printf("Job %s rejected: %s", jobID, reason)
		a.updateJobStatus(jobID, "failed", reason, claimToken)
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

	log.Printf("Printing job %s on printer %s (%d bytes, type=%s, path=%s)", jobID, printerID, len(pl.Data), pl.Type, kind)

	// The durable local ledger is a PRECONDITION for dispatch: BeginPrint
	// atomically records the attempt (with its claim token) as 'printing'.
	// If that write fails, we could never prove after a crash whether this
	// job physically printed, so we refuse BEFORE sending a single byte.
	if err := a.queue.BeginPrint(jobID, printerID, pl.Data, claimToken); err != nil {
		lock.Unlock()
		log.Printf("Job %s: local durable ledger unavailable; refusing dispatch (no bytes sent): %v", jobID, err)
		// Fenced pre-execution return (never dispatched, zero bytes sent):
		// the gateway requeues without burning the retry budget.
		a.rejectJob(jobID, claimToken, "ledger_unavailable")
		return
	}
	lock.Unlock()

	// Report printing outside the per-printer lock (network I/O must not
	// hold mutex) - AND gate physical dispatch on the gateway's answer.
	if err := a.updateJobStatus(jobID, "printing", "", claimToken); err != nil {
		if proceed, reason := a.authorizeDispatchAfterReportFailure(jobID, expiresAtStr, err); !proceed {
			log.Printf("Job %s: physical dispatch refused (%s); aborting before any byte is sent", jobID, reason)
			if aberr := a.queue.AbortPrint(jobID, "dispatch_refused: "+reason+"; zero bytes transmitted"); aberr != nil {
				log.Printf("Job %s: failed to abort local ledger row: %v", jobID, aberr)
			}
			return
		} else {
			log.Printf("Job %s: printing report unacknowledged (%v); ownership still provable, proceeding with ledger-tracked outcome", jobID, err)
		}
	}

	// The document budget scales with size: a 5MB payload on a slow thermal
	// legitimately needs minutes to transfer. Transports enforce finer
	// stall detection (per-write deadlines); this is the hard cap against a
	// permanently stuck device. While printing, the heartbeat keep-alive
	// keeps the gateway's printing lease fresh.
	printCtx, cancel := context.WithTimeout(ctx, printDocumentTimeout(len(pl.Data)))
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
	printData := pl.Data
	hasActivePeripherals := (pl.Peripherals.Drawer != "" && pl.Peripherals.Drawer != "none") ||
		(pl.Peripherals.Cutter != "" && pl.Peripherals.Cutter != "none") ||
		(pl.Peripherals.Buzzer != "" && pl.Peripherals.Buzzer != "none")
	if hasActivePeripherals {
		profile := printer.PeripheralProfile{
			DrawerKickMode: pl.Peripherals.Drawer,
			CutterMode:     pl.Peripherals.Cutter,
			BuzzerMode:     pl.Peripherals.Buzzer,
		}
		printData = printer.WrapPeripheralCommands(printData, pl.Protocol, profile)
	}
	printErr := printer.PrintDocument(printCtx, p, printer.Document{Kind: kind, Data: printData, JobID: jobID})

	failureMsg := ""
	if printErr != nil {
		failureMsg = printErr.Error()
		// Belt and braces: if the transport chain proved an ambiguous
		// physical outcome but lost the marker through wrapping, restore it
		// here so the gateway can NEVER classify this as safely retryable.
		if printer.OutcomeUnknown(printErr) && !printer.HasUnknownOutcomeMarker(failureMsg) {
			failureMsg = "UNKNOWN_PARTIAL_DELIVERY: " + failureMsg
		}
		if err := a.queue.UpdateStatusWithError(jobID, "failed", failureMsg); err != nil {
			log.Printf("Job %s: ledger write failed after print failure: %v", jobID, err)
		}
	} else {
		if err := a.queue.UpdateStatus(jobID, "success"); err != nil {
			// A lost success record is honest (restart marks it
			// AGENT_RESTART_DURING_PRINT), but the operator should know the
			// local evidence of a successful physical print was not stored.
			log.Printf("Job %s: ledger write failed after successful print: %v", jobID, err)
		}
	}
	lock.Unlock()

	if printErr != nil {
		log.Printf("Job %s FAILED on printer %s: %v", jobID, printerID, printErr)
		a.updateJobStatus(jobID, "failed", failureMsg, claimToken)
		return
	}

	log.Printf("Job %s: payload transmitted successfully to printer %s", jobID, printerID)
	a.updateJobStatus(jobID, "success", "", claimToken)
}

// ErrStaleClaim is returned by updateJobStatus when the gateway rejects a
// status report at the claim fence (HTTP 409/410 or a STALE_CLAIM /
// FENCE_REJECTED payload): this attempt no longer owns the job. processJob
// treats it as a HARD STOP before any byte reaches the printer.
var ErrStaleClaim = errors.New("gateway rejected claim fence: stale or reclaimed token")

// ErrTransitionRejected is returned by updateJobStatus when the gateway
// answers a status report with an explicit non-fence rejection (any other
// 4xx/5xx). Unlike a transport error, this IS authoritative: the gateway
// evaluated our transition and refused it, so physical dispatch must stop.
var ErrTransitionRejected = errors.New("gateway rejected status transition")

func (a *Agent) updateJobStatus(jobID, status, errMsg, claimToken string) error {
	reqURL := fmt.Sprintf("%s/api/agent/jobs", a.cfg.Server.URL)
	body := map[string]interface{}{
		"jobId":  jobID,
		"status": status,
		"error":  errMsg,
	}
	if claimToken != "" {
		body["claimToken"] = claimToken
	}
	resp, err := a.doAuthorizedRequest("PATCH", reqURL, body)
	if err != nil {
		log.Printf("Job %s: failed to report status %q to server: %v", jobID, status, err)
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		log.Printf("Job %s: server rejected status update to %q (%d): %s", jobID, status, resp.StatusCode, string(respBody))
		// Fence rejection: the gateway no longer recognizes this claim
		// (expired and reassigned, or never valid). Callers MUST treat this
		// as authoritative - especially the claimed->printing transition,
		// which must never proceed to hardware afterwards.
		if resp.StatusCode == http.StatusConflict || resp.StatusCode == http.StatusGone ||
			strings.Contains(string(respBody), "STALE_CLAIM") || strings.Contains(string(respBody), "FENCE_REJECTED") {
			return fmt.Errorf("%w: job %s status %q rejected (%d)", ErrStaleClaim, jobID, status, resp.StatusCode)
		}
		return fmt.Errorf("%w to %q (%d): %s", ErrTransitionRejected, status, resp.StatusCode, string(respBody))
	}
	return nil
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
