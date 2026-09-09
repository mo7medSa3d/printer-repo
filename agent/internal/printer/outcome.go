package printer

import (
	"errors"
	"fmt"
	"strings"
)

// ErrOutcomeUnknown is the sentinel for "bytes may have physically reached
// the printer but the outcome cannot be proven". Every transport must wrap
// post-first-byte failures with it, and it must NEVER be downgraded into a
// plain failure by wrapping chains: classifyOutcome inspects the full chain.
//
// Its message text IS the wire marker the gateway recognizes
// (src/lib/job-status.ts: PHYSICAL_OUTCOME_UNKNOWN_MARKERS). Changing the
// text without the gateway list silently converts unknown outcomes into
// auto-retryable failures — a physical double-print bug.
var ErrOutcomeUnknown = errors.New("UNKNOWN_PARTIAL_DELIVERY")

// OutcomeMarkers mirrors the gateway's PHYSICAL_OUTCOME_UNKNOWN_MARKERS and
// the agent-produced markers in queue. The single list lives here; the
// gateway list lives in src/lib/job-status.ts; tests on BOTH sides assert
// these values stay identical (contract test).
var OutcomeMarkers = []string{
	"AGENT_EXECUTION_TIMEOUT",
	"AGENT_RESTART_DURING_PRINT",
	"JOB_EXPIRED_DURING_PRINT",
	"UNKNOWN_PARTIAL_DELIVERY",
	"UNKNOWN_SUBMISSION_OUTCOME",
}

// MarkUnknown prefixes err so gateway-side derivePhysicalOutcome returns
// "unknown". It is idempotent: a message that already starts with one of
// the markers is returned unchanged.
func MarkUnknown(format string, args ...interface{}) error {
	msg := fmt.Sprintf(format, args...)
	if HasUnknownOutcomeMarker(msg) {
		return errors.New(msg)
	}
	return fmt.Errorf("%w: %s", ErrOutcomeUnknown, msg)
}

// HasUnknownOutcomeMarker reports whether a serialized error message carries
// one of the unknown-outcome markers (gateway-compatible prefix check).
func HasUnknownOutcomeMarker(msg string) bool {
	for _, marker := range OutcomeMarkers {
		if strings.HasPrefix(msg, marker) {
			return true
		}
	}
	return false
}

// OutcomeUnknown reports whether an error from any layer of this package
// must be treated as physically ambiguous (no auto-retry, no failover).
func OutcomeUnknown(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrOutcomeUnknown) {
		return true
	}
	return HasUnknownOutcomeMarker(err.Error())
}
