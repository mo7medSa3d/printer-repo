package printer

import (
	"testing"
	"time"
)

func TestSpoolerPrinter_Status_ProbeSuccess(t *testing.T) {
	sp := &SpoolerPrinter{
		Name:        "Test Spooler",
		SpoolerName: "Test_Spooler",
		Timeout:     200 * time.Millisecond,
		ProbeFunc: func(name string) string {
			return "online"
		},
	}

	st := sp.Status()
	if st != "online" {
		t.Fatalf("expected status 'online', got %q", st)
	}
}

func TestSpoolerPrinter_Status_ProbeTimeout(t *testing.T) {
	sp := &SpoolerPrinter{
		Name:        "Hanging Spooler",
		SpoolerName: "Hanging_Spooler",
		Timeout:     50 * time.Millisecond,
		ProbeFunc: func(name string) string {
			time.Sleep(1 * time.Second)
			return "online"
		},
	}

	start := time.Now()
	st := sp.Status()
	elapsed := time.Since(start)

	if st != "spooler_rpc_unresponsive" {
		t.Fatalf("expected status 'spooler_rpc_unresponsive', got %q", st)
	}
	if elapsed > 300*time.Millisecond {
		t.Fatalf("expected status to return within deadline, took %v", elapsed)
	}
}

func TestSpoolerPrinter_Status_ProbePanic(t *testing.T) {
	sp := &SpoolerPrinter{
		Name:        "Panic Spooler",
		SpoolerName: "Panic_Spooler",
		Timeout:     200 * time.Millisecond,
		ProbeFunc: func(name string) string {
			panic("driver crashed")
		},
	}

	st := sp.Status()
	if st != "error" {
		t.Fatalf("expected status 'error', got %q", st)
	}
}
