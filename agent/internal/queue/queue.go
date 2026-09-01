package queue

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "github.com/mattn/go-sqlite3"
)

// Queue is the Agent's local durable delivery queue. It is distinct from the
// Gateway's PostgreSQL job table:
//
//	Gateway PG: queued → claimed (lease) → printing → success/failed/expired  (cloud ownership)
//	Agent SQLite: queued → printing → success/failed                          (local execution)
//
// The local record id == Gateway job_id for correlation. The local queue
// survives agent crashes, Windows restarts, and network outages via WAL.
type Queue struct {
	db *sql.DB
}

func New(dbPath string) (*Queue, error) {
	if dbPath == "" {
		return nil, fmt.Errorf("queue db path is empty")
	}
	// A completely fresh Windows installation has no C:\ProgramData\OdooPrintAgent
	// directory. Always create it before SQLite opens the database file.
	dir := filepath.Dir(dbPath)
	if dir == "" || dir == "." {
		dir = "."
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create queue directory %s: %w", dir, err)
	}

	// _busy_timeout + WAL + synchronous=NORMAL are required for crash safety
	// on Windows without blocking the per-printer serialization mutex.
	dsn := fmt.Sprintf("%s?_busy_timeout=5000&_journal_mode=WAL&_synchronous=NORMAL", dbPath)
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite handles writes best with one writer. The application continues to
	// parallelize printer work through per-printer goroutines; database access
	// is deliberately serialized to avoid SQLITE_BUSY on Windows.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	// Ensure WAL is actually on (some sqlite builds ignore dsn params).
	// Non-fatal: the queue still works in rollback-journal mode.
	_, _ = db.Exec(`PRAGMA journal_mode=WAL`)
	_, _ = db.Exec(`PRAGMA synchronous=NORMAL`)
	_, _ = db.Exec(`PRAGMA busy_timeout=5000`)

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS print_jobs (
			id TEXT PRIMARY KEY,
			printer_id TEXT NOT NULL,
			payload BLOB NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('queued','printing','success','failed')),
			retries INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			claimed_at DATETIME
		);
		CREATE INDEX IF NOT EXISTS idx_queue_status ON print_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_queue_printer ON print_jobs(printer_id);
	`)
	if err != nil {
		return nil, err
	}

	// Migrate legacy schema from Phase 0 (had only id,printer_id,payload,status,retries,created_at)
	// Add missing columns if they don't exist (ALTER TABLE ADD COLUMN IF NOT EXISTS is sqlite 3.35+)
	for _, col := range []string{
		`ALTER TABLE print_jobs ADD COLUMN last_error TEXT`,
		`ALTER TABLE print_jobs ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
		`ALTER TABLE print_jobs ADD COLUMN claimed_at DATETIME`,
	} {
		_, _ = db.Exec(col)
	}

	return &Queue{db: db}, nil
}

func (q *Queue) Close() error {
	if q.db != nil {
		return q.db.Close()
	}
	return nil
}

func (q *Queue) IsProcessed(id string) bool {
	var count int
	err := q.db.QueryRow("SELECT COUNT(*) FROM print_jobs WHERE id = ? AND status = 'success'", id).Scan(&count)
	return err == nil && count > 0
}

// Push inserts a new job idempotently; duplicate ids are ignored (insert-or-ignore)
// so that a retried Gateway delivery never causes a second physical print.
func (q *Queue) Push(id, printerID string, payload []byte) error {
	_, err := q.db.Exec(
		`INSERT OR IGNORE INTO print_jobs (id, printer_id, payload, status) VALUES (?, ?, ?, 'queued')`,
		id, printerID, payload,
	)
	return err
}

// UpdateStatus sets a simple status (queued/printing/success/failed) and bumps updated_at.
func (q *Queue) UpdateStatus(id, status string) error {
	_, err := q.db.Exec(`UPDATE print_jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, status, id)
	return err
}

// UpdateStatusWithError also records last_error.
func (q *Queue) UpdateStatusWithError(id, status, lastErr string) error {
	_, err := q.db.Exec(`UPDATE print_jobs SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, status, lastErr, id)
	return err
}

// Get returns the local record for a gateway job id, if present.
func (q *Queue) Get(id string) (printerID string, status string, found bool, err error) {
	err = q.db.QueryRow(`SELECT printer_id, status FROM print_jobs WHERE id = ?`, id).Scan(&printerID, &status)
	if err == sql.ErrNoRows {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return printerID, status, true, nil
}

// InterruptedMarker prefixes the local last_error of a job that was still
// physically printing when the agent process stopped. The physical outcome of
// such a job is UNKNOWN: the printer may have printed everything, part of the
// document, or nothing at all. The marker makes that ambiguity explicit
// instead of letting the job look like an ordinary transient failure.
const InterruptedMarker = "AGENT_RESTART_DURING_PRINT"

// InterruptedJob is a job that was left mid-print by a crash/restart.
type InterruptedJob struct {
	ID        string
	PrinterID string
}

// MarkInterrupted moves every job still recorded as 'printing' into a terminal
// local 'failed' state carrying InterruptedMarker, and returns them.
//
// It must be called exactly once at startup, before any new job is accepted:
// a row in 'printing' after a fresh start can only mean the previous process
// died while the document was at the printer.
func (q *Queue) MarkInterrupted() ([]InterruptedJob, error) {
	rows, err := q.db.Query(`SELECT id, printer_id FROM print_jobs WHERE status = 'printing'`)
	if err != nil {
		return nil, err
	}
	var found []InterruptedJob
	for rows.Next() {
		var j InterruptedJob
		if err := rows.Scan(&j.ID, &j.PrinterID); err != nil {
			rows.Close()
			return nil, err
		}
		found = append(found, j)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	for _, j := range found {
		msg := InterruptedMarker + ": the agent stopped while this job was printing; the physical output is unknown (it may have printed fully, partially, or not at all)"
		if err := q.UpdateStatusWithError(j.ID, "failed", msg); err != nil {
			return found, err
		}
	}
	return found, nil
}

// WasInterrupted reports whether the local record for id is the terminal
// failure produced by MarkInterrupted (i.e. a crash during physical printing).
func (q *Queue) WasInterrupted(id string) bool {
	var status string
	var lastErr sql.NullString
	if err := q.db.QueryRow(`SELECT status, last_error FROM print_jobs WHERE id = ?`, id).Scan(&status, &lastErr); err != nil {
		return false
	}
	if status != "failed" || !lastErr.Valid {
		return false
	}
	return strings.HasPrefix(lastErr.String, InterruptedMarker)
}

// CountByStatus is a small diagnostic helper for the Tauri/desktop health view.
func (q *Queue) CountByStatus(status string) (int, error) {
	var n int
	err := q.db.QueryRow(`SELECT COUNT(*) FROM print_jobs WHERE status = ?`, status).Scan(&n)
	return n, err
}

// LastError returns the recorded failure reason for a job, if any. It is used
// when a duplicate delivery of an already-failed job must be re-reported to
// the gateway with its real terminal error instead of being printed again.
func (q *Queue) LastError(id string) string {
	var lastErr sql.NullString
	if err := q.db.QueryRow(`SELECT last_error FROM print_jobs WHERE id = ?`, id).Scan(&lastErr); err != nil {
		return ""
	}
	if !lastErr.Valid {
		return ""
	}
	return lastErr.String
}
