//go:build windows

package printer

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// Windows PDF printing.
//
// Two paths, chosen by execution context:
//
//  1. Headless CLI renderer (SumatraPDF preferred, pdf_print_command first
//     via pdf.go). Deterministic, dialog-free, Session-0 safe. This is the
//     ONLY path used when running as a Windows Service: GUI handlers
//     (Adobe/Edge) hang or crash in Session 0, which has no interactive
//     desktop for GDI/DDE.
//  2. ShellExecuteExW "printto" fallback, interactive sessions ONLY. Keeps
//     every currently-working desktop setup printing when no headless
//     renderer is installed. Never used from a service.
//
// SumatraPDF resolution order:
//   1. Next to the executing binary (e.g. C:\Program Files\OdooPrintAgent\SumatraPDF.exe)
//   2. Next to the config file (%ProgramData%\OdooPrintAgent\bin\SumatraPDF.exe)
//   3. Standard installation paths in %ProgramFiles% or %ProgramFiles(x86)%
//   4. PATH lookup

func findSumatraPDF() (string, error) {
	// Check beside executable
	if exe, err := os.Executable(); err == nil {
		beside := filepath.Join(filepath.Dir(exe), "SumatraPDF.exe")
		if _, err := os.Stat(beside); err == nil {
			return beside, nil
		}
		// Also check bin/ subfolder
		sub := filepath.Join(filepath.Dir(exe), "bin", "SumatraPDF.exe")
		if _, err := os.Stat(sub); err == nil {
			return sub, nil
		}
	}

	// Check ProgramData
	if pd := os.Getenv("ProgramData"); pd != "" {
		p := filepath.Join(pd, "OdooPrintAgent", "bin", "SumatraPDF.exe")
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}

	// Check ProgramFiles
	for _, envVar := range []string{"ProgramFiles", "ProgramFiles(x86)", "LocalAppData"} {
		if val := os.Getenv(envVar); val != "" {
			cand := filepath.Join(val, "SumatraPDF", "SumatraPDF.exe")
			if _, err := os.Stat(cand); err == nil {
				return cand, nil
			}
		}
	}

	// Check PATH
	if p, err := exec.LookPath("SumatraPDF.exe"); err == nil {
		return p, nil
	}

	return "", fmt.Errorf("SumatraPDF.exe not found in application directories, ProgramFiles, or PATH")
}

// runningAsService reports whether this process runs as a Windows Service
// (Session 0). On any doubt it reports service=true: the headless path is
// always safe, while the GUI path is only safe interactively.
func runningAsService() bool {
	isSvc, err := svc.IsWindowsService()
	if err != nil {
		return true
	}
	return isSvc
}

// platformPrintPDF prints pdfPath on printerName, choosing the safe renderer
// for the current execution context.
func platformPrintPDF(ctx context.Context, printerName, pdfPath string) error {
	// Sanitize printer name: remove trailing backslashes (they escape the
	// closing quote under CommandLineToArgvW rules) and reject quotes.
	sanitizedPrinter := strings.TrimRight(printerName, "\\")
	if strings.ContainsAny(sanitizedPrinter, "\"") {
		return fmt.Errorf("invalid printer name %q: contains quotes", printerName)
	}

	if sumatraPath, err := findSumatraPDF(); err == nil {
		log.Printf("PDF on %q via headless renderer %s", sanitizedPrinter, sumatraPath)
		return printPDFViaSumatra(ctx, sumatraPath, sanitizedPrinter, pdfPath)
	}

	if runningAsService() {
		return fmt.Errorf(
			"Session 0 headless PDF printing requires SumatraPDF (no interactive handler is usable from a Windows Service): %w (place SumatraPDF.exe in the agent directory or set pdf_print_command in agent.yaml)",
			fmt.Errorf("SumatraPDF.exe not found"),
		)
	}

	log.Printf("PDF on %q via system printto handler (no headless renderer installed)", sanitizedPrinter)
	return printPDFViaShellHandler(ctx, sanitizedPrinter, pdfPath)
}

// printPDFViaSumatra executes headless PDF printing using SumatraPDF.exe:
// -print-to <printerName> : prints to specified printer
// -silent                 : suppresses error dialogs
// -exit-when-done         : terminates SumatraPDF when printing completes
func printPDFViaSumatra(ctx context.Context, sumatraPath, printerName, pdfPath string) error {
	cmd := exec.CommandContext(ctx, sumatraPath, "-print-to", printerName, "-silent", "-exit-when-done", pdfPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow: true,
	}

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			// Print was killed by timeout/cancel; bytes may have already been dispatched to spooler.
			return MarkUnknown("headless PDF printing on %q did not finish within budget (submission state unknown): %v", printerName, ctx.Err())
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			msg := strings.TrimSpace(stderr.String())
			if msg != "" {
				return MarkUnknown("SumatraPDF exited with code %d: %s (submission state unknown)", exitErr.ExitCode(), msg)
			}
			return MarkUnknown("SumatraPDF exited with code %d (submission state unknown)", exitErr.ExitCode())
		}
		return fmt.Errorf("executing SumatraPDF for %q failed: %w", printerName, err)
	}

	return nil
}

const (
	seeMaskNoCloseProcess = 0x00000040
	seeMaskFlagNoUI       = 0x00000400
	seeMaskNoAsync        = 0x00000100
	swHide                = 0
)

type shellExecuteInfoW struct {
	cbSize         uint32
	fMask          uint32
	hwnd           windows.Handle
	lpVerb         *uint16
	lpFile         *uint16
	lpParameters   *uint16
	lpDirectory    *uint16
	nShow          int32
	hInstApp       windows.Handle
	lpIDList       uintptr
	lpClass        *uint16
	hkeyClass      windows.Handle
	dwHotKey       uint32
	hIconOrMonitor windows.Handle
	hProcess       windows.Handle
}

var (
	modShell32          = windows.NewLazySystemDLL("shell32.dll")
	procShellExecuteExW = modShell32.NewProc("ShellExecuteExW")
)

// printPDFViaShellHandler submits pdfPath with ShellExecuteExW using the
// "printto" verb: the application registered for .pdf renders the document
// and prints it through the selected printer's Windows driver.
//
// INTERACTIVE SESSIONS ONLY. GUI handlers hang or crash in Session 0, so
// platformPrintPDF never routes services here.
//
// Safety properties:
//   - no shell is involved (no cmd.exe, no string-concatenated command line);
//   - the file path comes from os.CreateTemp inside a 0700 temp directory;
//   - the printer name carries no quotes (rejected above), so the single
//     quoted parameter can never terminate early and inject arguments;
//   - the spawned handler is waited on (SEE_MASK_NOCLOSEPROCESS +
//     WaitForSingleObject) so a failure is a real error, and the temp file is
//     only deleted after the handler has exited.
func printPDFViaShellHandler(ctx context.Context, printerName, pdfPath string) error {
	verb, err := windows.UTF16PtrFromString("printto")
	if err != nil {
		return fmt.Errorf("encode printto verb: %w", err)
	}
	file, err := windows.UTF16PtrFromString(pdfPath)
	if err != nil {
		return fmt.Errorf("encode PDF path: %w", err)
	}
	// Quotes were rejected during sanitization, so this parameter can never
	// terminate early and inject further arguments.
	params, err := windows.UTF16PtrFromString(`"` + printerName + `"`)
	if err != nil {
		return fmt.Errorf("encode printer name: %w", err)
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
	if ret == 0 {
		// ShellExecuteExW failed before any handler process existed, so no
		// page can have been rendered — provably pre-dispatch.
		return fmt.Errorf(
			"ShellExecuteExW(printto) failed for printer %q: %v — install a PDF handler that supports the printto verb (e.g. Adobe Reader, SumatraPDF) or configure pdf_print_command in agent.yaml",
			printerName, lastErr,
		)
	}
	if info.hProcess == 0 {
		// No handler process to wait on: we cannot prove the document was
		// submitted, so this is reported as a failure instead of a silent OK.
		return fmt.Errorf(
			"PDF handler for printer %q did not start a process; cannot confirm submission — configure pdf_print_command in agent.yaml for a deterministic PDF path",
			printerName,
		)
	}
	defer windows.CloseHandle(info.hProcess)

	timeout := defaultPDFPrintTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 {
			timeout = remaining
		}
	}
	return waitPDFHandlerExit(info.hProcess, printerName, timeout)
}

// waitPDFHandlerExit waits for an ALREADY-LAUNCHED PDF handler process and
// classifies its terminal state. The handler owns the spool submission, so
// anything observed after launch is ambiguous: a timeout, a killed process,
// a failed exit-code read, or a non-zero exit code must NEVER be reported
// as a provably-not-printed (auto-retryable) failure. Only a clean zero
// exit is a definitive "submitted" (LAW: no retry after possible
// transmission).
func waitPDFHandlerExit(hProcess windows.Handle, printerName string, timeout time.Duration) error {
	waitMillis := uint32(timeout / time.Millisecond)
	event, err := windows.WaitForSingleObject(hProcess, waitMillis)
	if err != nil {
		return MarkUnknown("waiting for PDF handler of printer %q: %v (submission state unknown)", printerName, err)
	}
	if event == uint32(windows.WAIT_TIMEOUT) {
		// The PDF handler may have been mid-render when our budget expired:
		// pages can already be sitting in the physical spooler.
		return MarkUnknown("PDF handler for printer %q did not finish within %s (submission state unknown)", printerName, timeout)
	}

	var exitCode uint32
	if err := windows.GetExitCodeProcess(hProcess, &exitCode); err != nil {
		return MarkUnknown("reading PDF handler exit code for printer %q: %v (submission state unknown)", printerName, err)
	}
	if exitCode != 0 {
		// The renderer reports failure, but whether it handed pages to the
		// spooler before failing is not observable here. Post-launch
		// ambiguity must never be reported as a plain retryable failure.
		return MarkUnknown("PDF handler for printer %q exited with code %d (submission state unknown)", printerName, exitCode)
	}

	return nil
}
