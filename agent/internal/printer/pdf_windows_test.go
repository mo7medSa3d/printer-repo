//go:build windows

package printer

import (
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// launchProcessForTest starts a guaranteed-available process (cmd.exe, which
// always exists on Windows) through the same ShellExecuteExW path used for
// real PDF handlers, and returns the process handle. Tests exercise
// waitPDFHandlerExit directly so the LAW 1 outcome classification is proven
// without depending on a .pdf handler association (bare CI runners have
// none, and an unassociated file fails pre-launch - a different branch).
func launchProcessForTest(t *testing.T, args string) windows.Handle {
	t.Helper()
	verb, err := windows.UTF16PtrFromString("open")
	if err != nil {
		t.Fatalf("encode verb: %v", err)
	}
	file, err := windows.UTF16PtrFromString("cmd.exe")
	if err != nil {
		t.Fatalf("encode file: %v", err)
	}
	params, err := windows.UTF16PtrFromString(args)
	if err != nil {
		t.Fatalf("encode params: %v", err)
	}
	info := shellExecuteInfoW{
		fMask:        seeMaskNoCloseProcess | seeMaskFlagNoUI | seeMaskNoAsync,
		lpVerb:       verb,
		lpFile:       file,
		lpParameters: params,
		nShow:        swHide,
	}
	info.cbSize = uint32(unsafe.Sizeof(info))
	ret, _, lastErr := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&info)))
	if ret == 0 || info.hProcess == 0 {
		t.Fatalf("launch cmd.exe %q: %v", args, lastErr)
	}
	return info.hProcess
}

// A handler still running when the budget expires may have already spooled
// pages: the outcome must be unknown, never a plain retryable failure.
func TestPlatformPDFTimeoutIsUnknownOutcome(t *testing.T) {
	h := launchProcessForTest(t, "/c ping -n 20 127.0.0.1 >nul")
	defer windows.CloseHandle(h)
	err := waitPDFHandlerExit(h, "Test Printer", 300*time.Millisecond)
	if err == nil {
		t.Fatal("expected timeout error from waitPDFHandlerExit")
	}
	if !OutcomeUnknown(err) {
		t.Fatalf("PDF handler timeout must be classified unknown (got: %v)", err)
	}
	if !strings.HasPrefix(err.Error(), "UNKNOWN_PARTIAL_DELIVERY") {
		t.Fatalf("wire marker missing from message: %v", err)
	}
}

// A non-zero exit code is the renderer's own verdict, but pages may have
// been spooled before it failed: post-launch ambiguity must not be reported
// as provably-not-printed.
func TestPlatformPDFNonZeroExitIsUnknownOutcome(t *testing.T) {
	h := launchProcessForTest(t, "/c exit 7")
	defer windows.CloseHandle(h)
	err := waitPDFHandlerExit(h, "Test Printer", 20*time.Second)
	if err == nil {
		t.Fatal("expected error for non-zero handler exit")
	}
	if !OutcomeUnknown(err) {
		t.Fatalf("PDF handler non-zero exit must be classified unknown (got: %v)", err)
	}
}

// A clean zero exit is the only definitive "submitted" outcome.
func TestPlatformPDFCleanExitIsDefinitive(t *testing.T) {
	h := launchProcessForTest(t, "/c exit 0")
	defer windows.CloseHandle(h)
	if err := waitPDFHandlerExit(h, "Test Printer", 20*time.Second); err != nil {
		t.Fatalf("clean exit must be definitive success, got: %v", err)
	}
}
