package queue

import (
	"path/filepath"
	"testing"
)

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
	q, _ := New(filepath.Join(dir, "x.db"))
	defer q.Close()
	q.Push("j1", "p1", []byte("data"))
	if err := q.UpdateStatusWithError("j1", "failed", "dial timeout"); err != nil {
		t.Fatalf("UpdateStatusWithError: %v", err)
	}
	_, status, _, _ := q.Get("j1")
	if status != "failed" {
		t.Fatalf("expected failed, got %s", status)
	}
}
