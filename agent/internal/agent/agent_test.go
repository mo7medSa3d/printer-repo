package agent

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/odoo-print-agent/agent/internal/config"
	"github.com/odoo-print-agent/agent/internal/printer"
)

// fakePrinter for isolation tests
type fakePrinter struct {
	mu       sync.Mutex
	calls    int
	sleep    time.Duration
	failFirst bool
	status   string
	lastData []byte
}

func (f *fakePrinter) Print(ctx context.Context, data []byte) error {
	f.mu.Lock()
	f.calls++
	f.lastData = append([]byte(nil), data...)
	shouldFail := f.failFirst && f.calls == 1
	f.mu.Unlock()
	if shouldFail {
		return context.DeadlineExceeded
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(f.sleep):
		return nil
	}
}
func (f *fakePrinter) Test(ctx context.Context) error { return f.Print(ctx, []byte("test")) }
func (f *fakePrinter) Status() string {
	if f.status != "" {
		return f.status
	}
	return "online"
}

func newTestAgent(t *testing.T, printerID string, p printer.Printer) *Agent {
	t.Helper()
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = "http://localhost:3000"
	// bypass queue file by using temp
	qPath := t.TempDir() + "/q.db"
	// we need to set config path to temp so QueueDBPath lands there
	cfgPath := t.TempDir() + "/config.yaml"
	// create agent directly without calling New (to inject fake printer)
	ag, err := New(cfg, cfgPath)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// override auto-created printers with fake
	ag.printers = map[string]printer.Printer{printerID: p}
	ag.printerConfigs = map[string]config.PrinterConfig{printerID: {ID: printerID, Name: "Test", Type: "network", Endpoint: "127.0.0.1:9100"}}
	// override queue path for isolation (already created via New, but keep)
	_ = qPath
	return ag
}

func TestPerPrinterSerialization(t *testing.T) {
	p1 := &fakePrinter{sleep: 100 * time.Millisecond}
	ag := newTestAgent(t, "printer_1", p1)

	ctx := context.Background()
	// two jobs to same printer should serialize (second waits for first's lock)
	start := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			// use distinct job ids but same printer lock
			job := map[string]interface{}{
				"id":        string(rune('a'+n)) + "_job",
				"printerId": "printer_1",
				"payload":   map[string]interface{}{"type": "raw", "encoding": "base64", "data": "aGVsbG8="}, // "hello"
				"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
			}
			ag.processJob(ctx, job)
		}(i)
	}
	wg.Wait()
	elapsed := time.Since(start)
	// if serialized, elapsed >= 180ms (two 100ms sleeps serialized)
	if elapsed < 180*time.Millisecond {
		t.Fatalf("expected serialized execution, elapsed %v", elapsed)
	}
	if p1.calls != 2 {
		t.Fatalf("expected 2 calls, got %d", p1.calls)
	}
}

func TestDifferentPrintersConcurrent(t *testing.T) {
	p1 := &fakePrinter{sleep: 100 * time.Millisecond}
	p2 := &fakePrinter{sleep: 100 * time.Millisecond}
	cfg := &config.Config{}
	cfg.Agent.ID = "agt_test"
	cfg.Agent.Secret = "secret"
	cfg.Server.URL = "http://localhost:3000"
	ag, _ := New(cfg, t.TempDir()+"/config.yaml")
	ag.printers = map[string]printer.Printer{"p1": p1, "p2": p2}
	ag.printerConfigs = map[string]config.PrinterConfig{
		"p1": {ID: "p1", Name: "P1", Type: "network", Endpoint: "127.0.0.1:9100"},
		"p2": {ID: "p2", Name: "P2", Type: "network", Endpoint: "127.0.0.1:9101"},
	}
	ctx := context.Background()
	start := time.Now()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); ag.processJob(ctx, map[string]interface{}{"id": "j1", "printerId": "p1", "payload": map[string]interface{}{"type": "raw", "encoding": "base64", "data": "aGVsbG8="}, "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339)}) }()
	go func() { defer wg.Done(); ag.processJob(ctx, map[string]interface{}{"id": "j2", "printerId": "p2", "payload": map[string]interface{}{"type": "raw", "encoding": "base64", "data": "aGVsbG8="}, "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339)}) }()
	wg.Wait()
	elapsed := time.Since(start)
	// concurrent printers should finish ~100ms, not 200ms
	if elapsed > 170*time.Millisecond {
		t.Fatalf("expected concurrent, elapsed %v", elapsed)
	}
}

func TestTTLExpiredSkipped(t *testing.T) {
	p := &fakePrinter{}
	ag := newTestAgent(t, "p1", p)
	ctx := context.Background()
	job := map[string]interface{}{
		"id": "expired_job", "printerId": "p1",
		"payload": map[string]interface{}{"type": "raw", "encoding": "base64", "data": "aGVsbG8="},
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
		"payload": map[string]interface{}{"type": "raw", "encoding": "base64", "data": "aGVsbG8="},
		"expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339),
	}
	ag.processJob(ctx, job)
	if p.calls != 1 {
		t.Fatalf("first call expected 1, got %d", p.calls)
	}
	// second delivery of same job id should be skipped via IsProcessed
	ag.processJob(ctx, job)
	if p.calls != 1 {
		t.Fatalf("duplicate should be skipped, got %d", p.calls)
	}
}
