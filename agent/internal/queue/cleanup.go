package queue

// CleanupTerminal removes only terminal local print-job records. Queued and
// printing jobs are deliberately preserved so an operator can never erase
// work that is still eligible for physical delivery.
func (q *Queue) CleanupTerminal() (int, error) {
	result, err := q.db.Exec(`DELETE FROM print_jobs WHERE status IN ('success', 'failed')`)
	if err != nil {
		return 0, err
	}

	count, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

// CleanupTerminalJobs opens the agent's durable queue, removes terminal local
// records, and closes the database again. It is used by the CLI/Tauri command.
func CleanupTerminalJobs(dbPath string) (int, error) {
	q, err := New(dbPath)
	if err != nil {
		return 0, err
	}
	defer q.Close()
	return q.CleanupTerminal()
}
