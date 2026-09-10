package printer

import (
	"errors"
	"strings"
	"testing"
)

// The marker TEXT is the contract between the agent, the gateway
// (src/lib/job-status.ts) and Odoo (print_gateway.print_job). A rename here
// silently converts unknown outcomes into auto-retryable failures
// (physical double prints). This locks the wire values.
func TestOutcomeMarkersMatchGatewayContract(t *testing.T) {
	want := []string{
		"AGENT_EXECUTION_TIMEOUT",
		"AGENT_RESTART_DURING_PRINT",
		"JOB_EXPIRED_DURING_PRINT",
		"UNKNOWN_PARTIAL_DELIVERY",
		"UNKNOWN_SUBMISSION_OUTCOME",
	}
	if len(OutcomeMarkers) != len(want) {
		t.Fatalf("OutcomeMarkers = %v, want %v", OutcomeMarkers, want)
	}
	for i, marker := range want {
		if OutcomeMarkers[i] != marker {
			t.Fatalf("OutcomeMarkers[%d] = %q, want %q", i, OutcomeMarkers[i], marker)
		}
	}
	if ErrOutcomeUnknown.Error() != "UNKNOWN_PARTIAL_DELIVERY" {
		t.Fatalf("ErrOutcomeUnknown = %q, must be the UNKNOWN_PARTIAL_DELIVERY marker", ErrOutcomeUnknown.Error())
	}
}

func TestMarkUnknownIsIdempotent(t *testing.T) {
	first := MarkUnknown("write %d/%d failed: %v", 10, 100, errors.New("boom"))
	if !strings.HasPrefix(first.Error(), "UNKNOWN_PARTIAL_DELIVERY: ") {
		t.Fatalf("MarkUnknown must prefix the marker, got %q", first.Error())
	}
	if !OutcomeUnknown(first) {
		t.Fatalf("OutcomeUnknown must recognize the marked error")
	}
	second := MarkUnknown("%s", first.Error())
	if strings.Count(second.Error(), "UNKNOWN_PARTIAL_DELIVERY") != 1 {
		t.Fatalf("MarkUnknown must not double-prefix, got %q", second.Error())
	}
	if OutcomeUnknown(errors.New("dial tcp: connection refused")) {
		t.Fatalf("pre-dispatch dial failure must NOT be unknown")
	}
	// Wrapping chains must not downgrade the classification.
	wrapped := errors.Join(errors.New("context"), first)
	if !OutcomeUnknown(wrapped) {
		t.Fatalf("OutcomeUnknown must survive error wrapping")
	}
}
