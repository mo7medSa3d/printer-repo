package queue

import "testing"

func TestCleanupTerminalRemovesOnlyTerminalJobs(t *testing.T) {
	dbPath := t.TempDir() + "/agent.db"
	q, err := New(dbPath)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defer q.Close()

	for _, id := range []string{"queued-job", "printing-job", "success-job", "failed-job"} {
		if err := q.Push(id, "printer-1", []byte("payload")); err != nil {
			t.Fatalf("Push(%s) error = %v", id, err)
		}
	}
	if err := q.UpdateStatus("printing-job", "printing"); err != nil {
		t.Fatal(err)
	}
	if err := q.UpdateStatus("success-job", "success"); err != nil {
		t.Fatal(err)
	}
	if err := q.UpdateStatus("failed-job", "failed"); err != nil {
		t.Fatal(err)
	}

	deleted, err := q.CleanupTerminal()
	if err != nil {
		t.Fatalf("CleanupTerminal() error = %v", err)
	}
	if deleted != 2 {
		t.Fatalf("CleanupTerminal() deleted = %d, want 2", deleted)
	}

	for _, id := range []string{"success-job", "failed-job"} {
		if _, _, found, err := q.Get(id); err != nil {
			t.Fatal(err)
		} else if found {
			t.Fatalf("terminal job %s still exists", id)
		}
	}
	for _, id := range []string{"queued-job", "printing-job"} {
		if _, _, found, err := q.Get(id); err != nil {
			t.Fatal(err)
		} else if !found {
			t.Fatalf("active job %s was removed", id)
		}
	}
}
