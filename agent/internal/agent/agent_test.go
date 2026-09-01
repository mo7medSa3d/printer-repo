package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/odoo-print-agent/agent/internal/config"
	"github.com/odoo-print-agent/agent/internal/printer"
)

const jobIDPrefix = "JOBID:"

func makeJobPayload(jobID string) map[string]interface{} {
	return map[string]interface{}{
		"type":     "raw",
		"encoding": "base64",
		"data":     base64.StdEncoding.EncodeToString([]byte(jobIDPrefix + jobID)),
	}
}

func jobIDFromPayload(data []byte) string {
	text := string(data)
	if strings.HasPrefix(text, jobIDPrefix) {
		return strings.TrimPrefix(text, jobIDPrefix)
	}
	return ""
}

type fakePrinter struct {
	mu            sync.Mutex
	calls         int
	callsByJob    map[string]int
	attemptsByJob map[string]int
	spans         []printSpan
	failBefore    map[string]int
	blocked       chan struct{}
	startedCh     chan string
	allowReturn   chan struct{}
	status        string
}

type printSpan struct {
	start time.Time
	end   time.Time
}

func (f *fakePrinter) Spans() []printSpan {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]printSpan, len(f.spans))
	copy(out, f.spans)
	return out
}

func spansOverlap(a, b printSpan) bool {
	return a.start.Before(b.end) && b.start.Before(a.end)
}

func (f *fakePrinter) Print(ctx context.Context, data []byte) error {
	jobID := jobIDFromPayload(data)
	start := time.Now()
	f.mu.Lock()
	if f.callsByJob == nil {
		f.callsByJob = map[string]int{}
	}
	if f.attemptsByJob == nil {
		f.attemptsByJob = map[string]int{}
	}
	if f.failBefore == nil {
		f.failBefore = map[string]int{}
	}
	f.attemptsByJob[jobID]++
	if n := f.failBefore[jobID]; n > 0 {
		f.failBefore[jobID]--
		f.mu.Unlock()
		return context.DeadlineExceeded
	}
	f.calls++
	f.callsByJob[jobID]++
	if f.startedCh != nil {
		select {
		case f.startedCh <- jobID:
		default:
		}
	}
	f.mu.Unlock()
	if f.blocked != nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-f.blocked:
		}
	}
	if f.allowReturn != nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-f.allowReturn:
		}
	}
	f.mu.Lock()
	f.spans = append(f.spans, printSpan{start: start, end: time.Now()})
	f.mu.Unlock()
	return nil
}

func (f *fakePrinter) Test(ctx context.Context) error { return f.Print(ctx, []byte(jobIDPrefix+"test")) }

func (f *fakePrinter) Status() string {
	if f.status != "" {
		return f.status
	}
	return "online"
}

func newStatusTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/jobs":
			switch r.Method {
			case http.MethodPatch:
				var body map[string]interface{}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					http.Error(w, "invalid json", http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"success":true}`))
				return
			case http.MethodGet:
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`[]`))
				return
			default:
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}
		default:
			http.NotFound(w, r)
		}
	}))
}

func newTestAgent(t *testing.T, printerID string, p printer.Printer) *Agent {
	t.Helper()
	server := newStatusTestServer(t)
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "config.yaml")
	ag, err := New(cfg, cfgPath)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ag.printers = map[string]printer.Printer{printerID: p}
	ag.printerConfigs = map[string]config.PrinterConfig{printerID: {ID: printerID, Name: "Test", Type: "network", Endpoint: "127.0.0.1:9100"}}
	t.Cleanup(func() {
		server.Close()
		if err := ag.Close(); err != nil {
			t.Logf("Agent.Close() error: %v", err)
		}
	})
	return ag
}

func assertNoInFlight(t *testing.T, ag *Agent) {
	t.Helper()
	ag.inFlightMu.Lock()
	defer ag.inFlightMu.Unlock()
	if len(ag.inFlight) != 0 {
		t.Fatalf("jobs still in flight after completion: %v", ag.inFlight)
	}
}

func TestPerPrinterSerialization(t *testing.T) {
	p1 := &fakePrinter{}
	ag := newTestAgent(t, "printer_1", p1)
	ctx := context.Background()
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			<-start
			job := map[string]interface{}{
				"id":        fmt.Sprintf("serial_%d", n),
				"printerId": "printer_1",
				"payload":   makeJobPayload(fmt.Sprintf("serial_%d", n)),
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.processJob(ctx, job)
		}(i)
	}
	close(start)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if p1.calls != 2 {
		t.Fatalf("expected 2 calls, got %d", p1.calls)
	}
	spans := p1.Spans()
	if len(spans) != 2 {
		t.Fatalf("expected 2 recorded spans, got %d", len(spans))
	}
	if spansOverlap(spans[0], spans[1]) {
		t.Fatalf("expected serialized execution, print spans overlap: %+v", spans)
	}
}

func TestDifferentPrintersConcurrent(t *testing.T) {
	barrier := make(chan struct{})
	p1 := &fakePrinter{blocked: barrier, startedCh: make(chan string, 2)}
	p2 := &fakePrinter{blocked: barrier, startedCh: make(chan string, 2)}
	server := newStatusTestServer(t)
	defer server.Close()
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	tmpDir := t.TempDir()
	ag, err := New(cfg, filepath.Join(tmpDir, "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()
	ag.printers = map[string]printer.Printer{"p1": p1, "p2": p2}
	ag.printerConfigs = map[string]config.PrinterConfig{
		"p1": {ID: "p1", Name: "P1", Type: "network", Endpoint: "127.0.0.1:9100"},
		"p2": {ID: "p2", Name: "P2", Type: "network", Endpoint: "127.0.0.1:9101"},
	}
	ctx := context.Background()
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		ag.processJob(ctx, map[string]interface{}{"id": "j1", "printerId": "p1", "payload": makeJobPayload("j1"), "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339)})
	}()
	go func() {
		defer wg.Done()
		<-start
		ag.processJob(ctx, map[string]interface{}{"id": "j2", "printerId": "p2", "payload": makeJobPayload("j2"), "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339)})
	}()
	close(start)
	<-p1.startedCh
	<-p2.startedCh
	close(barrier)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	s1, s2 := p1.Spans(), p2.Spans()
	if len(s1) != 1 || len(s2) != 1 {
		t.Fatalf("expected one span per printer, got %d/%d", len(s1), len(s2))
	}
	if !spansOverlap(s1[0], s2[0]) {
		t.Fatalf("expected concurrent execution, spans do not overlap: %v vs %v", s1[0], s2[0])
	}
}

func TestSameJobIDAcrossTenConcurrentDispatches(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "printer_1", p)
	ctx := context.Background()
	const workers = 10
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			job := map[string]interface{}{
				"id":        "same_job_10",
				"printerId": "printer_1",
				"payload":   makeJobPayload("same_job_10"),
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.dispatchJob(ctx, job)
		}()
	}
	close(start)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if got := p.callsByJob["same_job_10"]; got != 1 {
		t.Fatalf("expected exactly one physical print for same jobID across 10 goroutines, got %d", got)
	}
}

func TestSameJobIDAcrossHundredConcurrentDispatches(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "printer_1", p)
	ctx := context.Background()
	const workers = 100
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			job := map[string]interface{}{
				"id":        "same_job_100",
				"printerId": "printer_1",
				"payload":   makeJobPayload("same_job_100"),
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.dispatchJob(ctx, job)
		}()
	}
	close(start)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if got := p.callsByJob["same_job_100"]; got != 1 {
		t.Fatalf("expected exactly one physical print for same jobID across 100 goroutines, got %d", got)
	}
}

func TestWSAndPollingDuplicateDeliverySameJobID(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "printer_1", p)
	ctx := context.Background()
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			job := map[string]interface{}{
				"id":        "ws_poll_same_job",
				"printerId": "printer_1",
				"payload":   makeJobPayload("ws_poll_same_job"),
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.dispatchJob(ctx, job)
		}()
	}
	close(start)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if got := p.callsByJob["ws_poll_same_job"]; got != 1 {
		t.Fatalf("expected exactly one print for WS+poll duplicate delivery, got %d", got)
	}
}

func TestDifferentJobsSamePrinterSerialized(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "printer_1", p)
	ctx := context.Background()
	const jobs = 25
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < jobs; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			job := map[string]interface{}{
				"id":        fmt.Sprintf("same_printer_%d", i),
				"printerId": "printer_1",
				"payload":   makeJobPayload(fmt.Sprintf("same_printer_%d", i)),
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.dispatchJob(ctx, job)
		}(i)
	}
	close(start)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if p.calls != jobs {
		t.Fatalf("expected %d calls, got %d", jobs, p.calls)
	}
	spans := p.Spans()
	for i := 1; i < len(spans); i++ {
		if spansOverlap(spans[i-1], spans[i]) {
			t.Fatalf("expected same-printer jobs to serialize; spans overlapped: %v vs %v", spans[i-1], spans[i])
		}
	}
}

func TestDifferentJobsAcrossThreePrintersConcurrent(t *testing.T) {
	p1 := &fakePrinter{}
	p2 := &fakePrinter{}
	p3 := &fakePrinter{}
	server := newStatusTestServer(t)
	defer server.Close()
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = server.URL
	tmpDir := t.TempDir()
	ag, err := New(cfg, filepath.Join(tmpDir, "config.yaml"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = ag.Close() }()
	ag.printers = map[string]printer.Printer{"p1": p1, "p2": p2, "p3": p3}
	ag.printerConfigs = map[string]config.PrinterConfig{
		"p1": {ID: "p1", Name: "P1", Type: "network", Endpoint: "127.0.0.1:9100"},
		"p2": {ID: "p2", Name: "P2", Type: "network", Endpoint: "127.0.0.1:9101"},
		"p3": {ID: "p3", Name: "P3", Type: "network", Endpoint: "127.0.0.1:9102"},
	}
	ctx := context.Background()
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			printerID := "p1"
			switch i % 3 {
			case 1:
				printerID = "p2"
			case 2:
				printerID = "p3"
			}
			job := map[string]interface{}{
				"id":        fmt.Sprintf("multi_%d", i),
				"printerId": printerID,
				"payload":   makeJobPayload(fmt.Sprintf("multi_%d", i)),
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.dispatchJob(ctx, job)
		}(i)
	}
	close(start)
	wg.Wait()
	ag.waitForJobs()
	assertNoInFlight(t, ag)
	if got := p1.calls + p2.calls + p3.calls; got != 12 {
		t.Fatalf("expected 12 total prints across 3 printers, got %d (%d+%d+%d)", got, p1.calls, p2.calls, p3.calls)
	}
	if len(p1.Spans()) == 0 || len(p2.Spans()) == 0 || len(p3.Spans()) == 0 {
		t.Fatal("expected at least one span on each printer")
	}
}

func TestPrintFailureThenRetry(t *testing.T) {
	p := &fakePrinter{failBefore: map[string]int{"retry_job": 1}}
	ag := newTestAgent(t, "printer_1", p)
	ctx := context.Background()
	job := map[string]interface{}{
		"id":        "retry_job",
		"printerId": "printer_1",
		"payload":   makeJobPayload("retry_job"),
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	}
	ag.processJob(ctx, job)
	if got := p.attemptsByJob["retry_job"]; got != 1 {
		t.Fatalf("first attempt should be recorded once even when it fails, got %d attempts", got)
	}
	if got := p.callsByJob["retry_job"]; got != 0 {
		t.Fatalf("failed first attempt should not count as a successful print, got %d successful calls", got)
	}
	ag.processJob(ctx, job)
	if got := p.attemptsByJob["retry_job"]; got != 2 {
		t.Fatalf("retry after failure should create exactly one second attempt, got %d total attempts", got)
	}
	if got := p.callsByJob["retry_job"]; got != 1 {
		t.Fatalf("retry after failure should succeed exactly once, got %d successful calls", got)
	}
	assertNoInFlight(t, ag)
}

func TestTTLExpiredSkipped(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "p1", p)
	ctx := context.Background()
	job := map[string]interface{}{
		"id": "expired_job", "printerId": "p1",
		"payload": makeJobPayload("expired_job"),
		"expiresAt": time.Now().Add(-time.Minute).Format(time.RFC3339),
	}
	ag.processJob(ctx, job)
	if p.calls != 0 {
		t.Fatalf("expired job should not call Print, got %d", p.calls)
	}
}

func TestDuplicateSkippedAfterSuccess(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "p1", p)
	ctx := context.Background()
	job := map[string]interface{}{
		"id": "dup_job", "printerId": "p1",
		"payload": makeJobPayload("dup_job"),
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	}
	ag.processJob(ctx, job)
	if p.calls != 1 {
		t.Fatalf("first call expected 1, got %d", p.calls)
	}
	ag.processJob(ctx, job)
	if p.calls != 1 {
		t.Fatalf("duplicate should be skipped, got %d", p.calls)
	}
	assertNoInFlight(t, ag)
}
