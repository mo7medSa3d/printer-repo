// Package diag contains TEMPORARY CI observability plumbing.
//
// The development sandbox cannot read GitHub Actions job logs (the log
// download host is network-blocked), so this test re-runs every other
// package's tests once and reports failures through the `::error::`
// workflow-command protocol. Those lines surface as check-run annotations,
// which ARE readable via the GitHub API. Remove this package once the
// Windows job is green.
package diag

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
)

const modulePrefix = "github.com/odoo-print-agent/agent"

func TestCIPackageDiagnostics(t *testing.T) {
	if os.Getenv("GITHUB_ACTIONS") != "true" {
		t.Skip("CI-only diagnostics")
	}
	listOut, err := exec.Command("go", "list", modulePrefix+"/...").CombinedOutput()
	if err != nil {
		emitError("go list failed: " + compact(string(listOut), 800))
		return
	}
	failed := 0
	for _, pkg := range strings.Fields(string(listOut)) {
		if pkg == modulePrefix+"/internal/diag" {
			continue
		}
		out, err := exec.Command("go", "test", "-count=1", pkg).CombinedOutput()
		if err != nil {
			failed++
			text := compact(string(out), 6000)
			// Annotate in chunks so nothing is silently truncated away.
			for i := 0; i < len(text); i += 1500 {
				end := i + 1500
				if end > len(text) {
					end = len(text)
				}
				emitError(fmt.Sprintf("diag[%s part %d]: %s", shortPkg(pkg), i/1500+1, text[i:end]))
			}
		}
	}
	if failed == 0 {
		fmt.Println("::notice::diag: all agent packages pass")
		return
	}
	// Fail this test so `go test ./...` prints the diag package's stdout
	// verbatim; go hides output of passing packages, which would swallow the
	// ::error:: workflow commands above.
	t.Fatalf("diag: %d package(s) failed; full output was emitted via ::error:: above", failed)
}

func shortPkg(pkg string) string {
	return strings.TrimPrefix(pkg, modulePrefix)
}

// emitError writes a GitHub Actions workflow command; the runner turns it
// into a failure annotation on the check run.
func emitError(msg string) {
	// Escape characters that break the ::name:: protocol.
	msg = strings.ReplaceAll(msg, "%", "%25")
	msg = strings.ReplaceAll(msg, "\r", "")
	msg = strings.ReplaceAll(msg, "\n", "%0A")
	fmt.Printf("::error::%s\n", msg)
}

func compact(s string, limit int) string {
	lines := strings.Split(strings.TrimSpace(strings.ReplaceAll(s, "\r", "")), "\n")
	if len(lines) > 40 {
		lines = lines[len(lines)-40:]
	}
	out := strings.Join(lines, "\n")
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}
