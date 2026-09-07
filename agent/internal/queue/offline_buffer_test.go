package queue

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestOfflineQueueFIFODrain(t *testing.T) {
	dir := t.TempDir()

	q1, err := NewOfflineQueue(dir)
	if err != nil {
		t.Fatalf("NewOfflineQueue: %v", err)
	}

	jobs := []OfflineJob{
		{ID: "job-offline-1", PrinterID: "printer-pos", Payload: []byte("payload 1")},
		{ID: "job-offline-2", PrinterID: "printer-label", Payload: []byte("payload 2")},
		{ID: "job-offline-3", PrinterID: "printer-office", Payload: []byte("payload 3")},
	}

	for _, j := range jobs {
		if err := q1.Enqueue(j); err != nil {
			t.Fatalf("Enqueue(%s): %v", j.ID, err)
		}
	}

	if n := q1.Len(); n != 3 {
		t.Fatalf("expected 3 jobs in queue, got %d", n)
	}

	// Close queue to test on-disk persistence
	if err := q1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Reopen from the same disk directory: verifies state recovery
	q2, err := NewOfflineQueue(dir)
	if err != nil {
		t.Fatalf("reopen NewOfflineQueue: %v", err)
	}
	defer q2.Close()

	if n := q2.Len(); n != 3 {
		t.Fatalf("reopened queue expected 3 jobs, got %d", n)
	}

	// Drain queue and verify strict FIFO ordering
	var drainedIDs []string
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	drainedCount, err := q2.Drain(ctx, func(job OfflineJob) error {
		drainedIDs = append(drainedIDs, job.ID)
		return nil
	})

	if err != nil {
		t.Fatalf("Drain error: %v", err)
	}
	if drainedCount != 3 {
		t.Fatalf("expected 3 drained jobs, got %d", drainedCount)
	}

	expectedIDs := []string{"job-offline-1", "job-offline-2", "job-offline-3"}
	if !reflect.DeepEqual(drainedIDs, expectedIDs) {
		t.Fatalf("FIFO order mismatch: got %v, expected %v", drainedIDs, expectedIDs)
	}

	if n := q2.Len(); n != 0 {
		t.Fatalf("expected empty queue after drain, got %d", n)
	}

	// Verify idempotency replay guard: completed jobs cannot be re-enqueued or re-executed
	for _, expectedID := range expectedIDs {
		if !q2.IsProcessed(expectedID) {
			t.Fatalf("expected job %s to be marked as processed in replay guard", expectedID)
		}
		// Attempt duplicate enqueue
		dupErr := q2.Enqueue(OfflineJob{ID: expectedID, PrinterID: "printer-dup", Payload: []byte("dup")})
		if !errors.Is(dupErr, ErrAlreadyProcessed) {
			t.Fatalf("expected ErrAlreadyProcessed for duplicate job %s, got %v", expectedID, dupErr)
		}
	}

	// Reopen a third time: verify replay guard survives process restart
	q3, err := NewOfflineQueue(dir)
	if err != nil {
		t.Fatalf("third reopen NewOfflineQueue: %v", err)
	}
	defer q3.Close()

	if n := q3.Len(); n != 0 {
		t.Fatalf("expected 0 pending jobs in q3, got %d", n)
	}
	if !q3.IsProcessed("job-offline-1") {
		t.Fatal("expected replay guard to persist processed status across restarts")
	}
	dupErr := q3.Enqueue(OfflineJob{ID: "job-offline-1", PrinterID: "printer-dup", Payload: []byte("dup")})
	if !errors.Is(dupErr, ErrAlreadyProcessed) {
		t.Fatalf("expected ErrAlreadyProcessed after restart, got %v", dupErr)
	}
}
