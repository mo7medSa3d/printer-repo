package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	ErrAlreadyProcessed = errors.New("job already processed")
	ErrDuplicateJob     = errors.New("job already queued")
	ErrQueueEmpty        = errors.New("offline queue is empty")
)

// OfflineJob represents a durable print job spooled to local disk.
type OfflineJob struct {
	ID        string    `json:"id"`
	PrinterID string    `json:"printer_id"`
	Payload   []byte    `json:"payload"`
	Kind      string    `json:"kind,omitempty"`
	Status    string    `json:"status"` // queued, draining, completed, failed
	Attempts  int       `json:"attempts"`
	LastError string    `json:"last_error,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	Sequence  int64     `json:"sequence"`
}

// OfflineQueue provides a thread-safe, disk-backed FIFO queue with status tracking
// and a client-side idempotency replay guard to prevent duplicate hardware execution.
type OfflineQueue struct {
	mu           sync.Mutex
	baseDir      string
	pendingDir   string
	completedDir string
	failedDir    string
	nextSeq      int64
	pending      []*OfflineJob
	pendingMap   map[string]*OfflineJob
	processed    map[string]bool
}

// NewOfflineQueue initializes or recovers an OfflineQueue from the specified directory.
func NewOfflineQueue(dir string) (*OfflineQueue, error) {
	if dir == "" {
		return nil, errors.New("offline queue directory is empty")
	}

	pendingDir := filepath.Join(dir, "pending")
	completedDir := filepath.Join(dir, "completed")
	failedDir := filepath.Join(dir, "failed")

	for _, d := range []string{pendingDir, completedDir, failedDir} {
		if err := os.MkdirAll(d, 0755); err != nil {
			return nil, fmt.Errorf("create offline queue dir %s: %w", d, err)
		}
	}

	oq := &OfflineQueue{
		baseDir:      dir,
		pendingDir:   pendingDir,
		completedDir: completedDir,
		failedDir:    failedDir,
		pendingMap:   make(map[string]*OfflineJob),
		processed:    make(map[string]bool),
	}

	if err := oq.recoverState(); err != nil {
		return nil, fmt.Errorf("recover offline queue: %w", err)
	}

	return oq, nil
}

func (oq *OfflineQueue) recoverState() error {
	// 1. Recover completed jobs into replay guard map
	completedFiles, err := os.ReadDir(oq.completedDir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, entry := range completedFiles {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(oq.completedDir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var job OfflineJob
		if err := json.Unmarshal(data, &job); err == nil && job.ID != "" {
			oq.processed[job.ID] = true
			if job.Sequence > oq.nextSeq {
				oq.nextSeq = job.Sequence
			}
		}
	}

	// 2. Recover pending jobs in FIFO order
	pendingFiles, err := os.ReadDir(oq.pendingDir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	// Sort filenames lexicographically so sequence %020d order is preserved
	names := make([]string, 0, len(pendingFiles))
	for _, entry := range pendingFiles {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		path := filepath.Join(oq.pendingDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var job OfflineJob
		if err := json.Unmarshal(data, &job); err == nil && job.ID != "" {
			if oq.processed[job.ID] {
				// Job was already processed previously; clean up from pending
				_ = os.Remove(path)
				continue
			}
			oq.pending = append(oq.pending, &job)
			oq.pendingMap[job.ID] = &job
			if job.Sequence > oq.nextSeq {
				oq.nextSeq = job.Sequence
			}
		}
	}

	return nil
}

func (oq *OfflineQueue) filenameFor(job *OfflineJob) string {
	// Format: %020d_<id>.json
	sanitizedID := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, job.ID)
	return fmt.Sprintf("%020d_%s.json", job.Sequence, sanitizedID)
}

// Enqueue stores a new job on disk in FIFO order, checking the replay guard.
func (oq *OfflineQueue) Enqueue(job OfflineJob) error {
	if job.ID == "" {
		return errors.New("job id cannot be empty")
	}

	oq.mu.Lock()
	defer oq.mu.Unlock()

	// Replay guard: do not re-enqueue or duplicate already completed or pending jobs
	if oq.processed[job.ID] {
		return fmt.Errorf("%w: %s", ErrAlreadyProcessed, job.ID)
	}
	if _, exists := oq.pendingMap[job.ID]; exists {
		return fmt.Errorf("%w: %s", ErrDuplicateJob, job.ID)
	}

	oq.nextSeq++
	job.Sequence = oq.nextSeq
	if job.CreatedAt.IsZero() {
		job.CreatedAt = time.Now().UTC()
	}
	job.Status = "queued"

	// Write to temporary file, then rename atomically
	fileName := oq.filenameFor(&job)
	targetPath := filepath.Join(oq.pendingDir, fileName)
	tempPath := targetPath + ".tmp"

	data, err := json.MarshalIndent(job, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal job %s: %w", job.ID, err)
	}

	if err := os.WriteFile(tempPath, data, 0644); err != nil {
		return fmt.Errorf("write job %s: %w", job.ID, err)
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("atomic commit job %s: %w", job.ID, err)
	}

	jobCopy := job
	oq.pending = append(oq.pending, &jobCopy)
	oq.pendingMap[job.ID] = &jobCopy

	return nil
}

// Push is an alias for Enqueue.
func (oq *OfflineQueue) Push(job OfflineJob) error {
	return oq.Enqueue(job)
}

// IsProcessed checks if the job ID has already been successfully printed / completed.
func (oq *OfflineQueue) IsProcessed(id string) bool {
	oq.mu.Lock()
	defer oq.mu.Unlock()
	return oq.processed[id]
}

// Len returns the number of pending jobs in the queue.
func (oq *OfflineQueue) Len() int {
	oq.mu.Lock()
	defer oq.mu.Unlock()
	return len(oq.pending)
}

// Peek returns the next job without removing it from the queue.
func (oq *OfflineQueue) Peek() (*OfflineJob, error) {
	oq.mu.Lock()
	defer oq.mu.Unlock()

	if len(oq.pending) == 0 {
		return nil, ErrQueueEmpty
	}
	jobCopy := *oq.pending[0]
	return &jobCopy, nil
}

// MarkCompleted records that a job finished printing, advancing the replay guard.
func (oq *OfflineQueue) MarkCompleted(jobID string) error {
	oq.mu.Lock()
	defer oq.mu.Unlock()

	job, exists := oq.pendingMap[jobID]
	if !exists {
		oq.processed[jobID] = true
		return nil
	}

	job.Status = "completed"
	oq.processed[jobID] = true
	delete(oq.pendingMap, jobID)

	// Remove from pending slice
	for i, j := range oq.pending {
		if j.ID == jobID {
			oq.pending = append(oq.pending[:i], oq.pending[i+1:]...)
			break
		}
	}

	// Move disk file from pending to completed
	fileName := oq.filenameFor(job)
	srcPath := filepath.Join(oq.pendingDir, fileName)
	dstPath := filepath.Join(oq.completedDir, fileName)

	data, err := json.MarshalIndent(job, "", "  ")
	if err == nil {
		_ = os.WriteFile(dstPath, data, 0644)
	}
	_ = os.Remove(srcPath)

	return nil
}

// MarkFailed updates the status of a job to failed with an error message.
func (oq *OfflineQueue) MarkFailed(jobID string, failureErr error) error {
	oq.mu.Lock()
	defer oq.mu.Unlock()

	job, exists := oq.pendingMap[jobID]
	if !exists {
		return nil
	}

	job.Status = "failed"
	job.Attempts++
	if failureErr != nil {
		job.LastError = failureErr.Error()
	}

	// Move disk file from pending to failed
	fileName := oq.filenameFor(job)
	srcPath := filepath.Join(oq.pendingDir, fileName)
	dstPath := filepath.Join(oq.failedDir, fileName)

	delete(oq.pendingMap, jobID)
	for i, j := range oq.pending {
		if j.ID == jobID {
			oq.pending = append(oq.pending[:i], oq.pending[i+1:]...)
			break
		}
	}

	data, err := json.MarshalIndent(job, "", "  ")
	if err == nil {
		_ = os.WriteFile(dstPath, data, 0644)
	}
	_ = os.Remove(srcPath)

	return nil
}

// Drain processes pending jobs in strict FIFO order using the provided handler.
// The replay guard ensures that already processed jobs are never executed twice.
// Returns the count of jobs drained and any error encountered.
func (oq *OfflineQueue) Drain(ctx context.Context, handler func(job OfflineJob) error) (int, error) {
	count := 0

	for {
		select {
		case <-ctx.Done():
			return count, ctx.Err()
		default:
		}

		oq.mu.Lock()
		if len(oq.pending) == 0 {
			oq.mu.Unlock()
			break
		}

		current := *oq.pending[0]
		// Client-side idempotency replay guard
		if oq.processed[current.ID] {
			// Already executed; remove from queue
			oq.pending = oq.pending[1:]
			delete(oq.pendingMap, current.ID)
			_ = os.Remove(filepath.Join(oq.pendingDir, oq.filenameFor(&current)))
			oq.mu.Unlock()
			continue
		}
		oq.mu.Unlock()

		// Execute job through handler outside mutex lock
		err := handler(current)
		if err != nil {
			_ = oq.MarkFailed(current.ID, err)
			return count, fmt.Errorf("drain job %s failed: %w", current.ID, err)
		}

		if err := oq.MarkCompleted(current.ID); err != nil {
			return count, err
		}
		count++
	}

	return count, nil
}

// StartDrainWorker spawns a background goroutine that drains the offline queue
// at periodic intervals or when notified, stopping gracefully when ctx is cancelled.
func (oq *OfflineQueue) StartDrainWorker(ctx context.Context, interval time.Duration, handler func(job OfflineJob) error) <-chan error {
	errCh := make(chan error, 1)

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		defer close(errCh)

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if oq.Len() > 0 {
					if _, err := oq.Drain(ctx, handler); err != nil && !errors.Is(err, context.Canceled) {
						select {
						case errCh <- err:
						default:
						}
					}
				}
			}
		}
	}()

	return errCh
}

// Close flushes and closes the queue resources.
func (oq *OfflineQueue) Close() error {
	oq.mu.Lock()
	defer oq.mu.Unlock()
	return nil
}
