package queue

import (
	"path/filepath"
	"testing"
)

func newTestQueue(t *testing.T) *Queue {
	t.Helper()
	q, err := New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = q.Close() })
	return q
}

func TestQueueIdempotencyAndStatus(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	q, err := New(dbPath)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer q.Close()

	id := "job_test123"
	if err := q.Push(id, "printer_1", []byte("hello")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	// duplicate push is idempotent (INSERT OR IGNORE)
	if err := q.Push(id, "printer_1", []byte("hello again")); err != nil {
		t.Fatalf("second Push: %v", err)
	}
	// still not processed
	if q.IsProcessed(id) {
		t.Fatalf("should not be processed yet")
	}
	// Get
	pid, status, found, err := q.Get(id)
	if err != nil || !found {
		t.Fatalf("Get failed: %v found=%v", err, found)
	}
	if pid != "printer_1" || status != "queued" {
		t.Fatalf("unexpected Get: %s %s", pid, status)
	}
	// transition to printing then success
	if err := q.UpdateStatus(id, "printing"); err != nil {
		t.Fatalf("UpdateStatus printing: %v", err)
	}
	if err := q.UpdateStatus(id, "success"); err != nil {
		t.Fatalf("UpdateStatus success: %v", err)
	}
	if !q.IsProcessed(id) {
		t.Fatalf("should be processed after success")
	}
	// reopen from same file survives restart
	q2, err := New(dbPath)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer q2.Close()
	if !q2.IsProcessed(id) {
		t.Fatalf("should survive reopen")
	}
	n, err := q2.CountByStatus("success")
	if err != nil {
		t.Fatalf("CountByStatus: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 success, got %d", n)
	}
}

func TestQueueUpdateWithError(t *testing.T) {
	dir := t.TempDir()
	q, err := New(filepath.Join(dir, "x.db"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer q.Close()
	if err := q.Push("j1", "p1", []byte("data")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := q.UpdateStatusWithError("j1", "failed", "dial timeout"); err != nil {
		t.Fatalf("UpdateStatusWithError: %v", err)
	}
	_, status, _, _ := q.Get("j1")
	if status != "failed" {
		t.Fatalf("expected failed, got %s", status)
	}
}

// A job left in 'printing' by a crash must become a terminal local failure
// carrying the interruption marker, so the ambiguity is explicit instead of
// looking like a normal transient failure.
func TestMarkInterruptedFlagsMidPrintJobs(t *testing.T) {
	q := newTestQueue(t)

	if err := q.Push("job_crash", "printer_1", []byte("data")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := q.UpdateStatus("job_crash", "printing"); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	if err := q.Push("job_done", "printer_1", []byte("data")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := q.UpdateStatus("job_done", "success"); err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}

	interrupted, err := q.MarkInterrupted()
	if err != nil {
		t.Fatalf("MarkInterrupted: %v", err)
	}
	if len(interrupted) != 1 || interrupted[0].ID != "job_crash" || interrupted[0].PrinterID != "printer_1" {
		t.Fatalf("expected only job_crash to be interrupted, got %#v", interrupted)
	}

	_, status, found, err := q.Get("job_crash")
	if err != nil || !found {
		t.Fatalf("Get(job_crash): found=%v err=%v", found, err)
	}
	if status != "failed" {
		t.Fatalf("interrupted job must be terminal locally, got %q", status)
	}
	if !q.WasInterrupted("job_crash") {
		t.Fatal("interrupted job must be detectable via WasInterrupted")
	}
	if q.WasInterrupted("job_done") {
		t.Fatal("a completed job must never be reported as interrupted")
	}

	// Idempotent: a second startup finds nothing left in 'printing'.
	again, err := q.MarkInterrupted()
	if err != nil {
		t.Fatalf("MarkInterrupted (2nd): %v", err)
	}
	if len(again) != 0 {
		t.Fatalf("second scan must find nothing, got %#v", again)
	}
}
