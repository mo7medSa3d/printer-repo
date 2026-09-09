package queue

// CleanupTerminal removes terminal local print-job records whose physical
// outcome is PROVABLE (success, or a plain failure). Rows carrying an
// unknown-outcome marker are deliberately preserved: they are the evidence
// that a document may have printed once already, and deleting them would let
// a later duplicate delivery reprint without any local protection (and would
// destroy the operator's reconciliation record).
func (q *Queue) CleanupTerminal() (int, error) {
	result, err := q.db.Exec(`DELETE FROM print_jobs WHERE status = 'success'
		OR (status = 'failed' AND (last_error IS NULL
			OR (last_error NOT LIKE 'AGENT_RESTART_DURING_PRINT%'
				AND last_error NOT LIKE 'UNKNOWN_PARTIAL_DELIVERY%')))`)
	if err != nil {
		return 0, err
	}

	count, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

// CountOutcomeUnknown returns how many locally-kept rows carry an unknown
// physical outcome (for operator reconciliation).
func (q *Queue) CountOutcomeUnknown() (int, error) {
	var n int
	err := q.db.QueryRow(`SELECT COUNT(*) FROM print_jobs WHERE status = 'failed' AND (
		last_error LIKE 'AGENT_RESTART_DURING_PRINT%' OR last_error LIKE 'UNKNOWN_PARTIAL_DELIVERY%')`).Scan(&n)
	return n, err
}

// PurgeOutcomeUnknown removes the retained unknown-outcome evidence AFTER an
// operator has explicitly reconciled (checked the physical output). This is
// intentionally a separate, deliberate operation.
func (q *Queue) PurgeOutcomeUnknown() (int, error) {
	result, err := q.db.Exec(`DELETE FROM print_jobs WHERE status = 'failed' AND (
		last_error LIKE 'AGENT_RESTART_DURING_PRINT%' OR last_error LIKE 'UNKNOWN_PARTIAL_DELIVERY%')`)
	if err != nil {
		return 0, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

// CleanupTerminalJobs opens the agent's durable queue, removes provable
// terminal local records (unknown-outcome evidence is preserved), and closes
// the database again. It is used by the CLI/Tauri command.
func CleanupTerminalJobs(dbPath string) (int, error) {
	q, err := New(dbPath)
	if err != nil {
		return 0, err
	}
	defer q.Close()
	return q.CleanupTerminal()
}
