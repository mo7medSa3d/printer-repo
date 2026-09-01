//go:build windows

package printer

import (
	"context"
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows PDF printing.
//
// The PDF is submitted with ShellExecuteExW using the "printto" verb: the
// application registered for .pdf renders the document and prints it through
// the selected printer's Windows driver. This is the documented Windows way
// to print a document to a specific printer, and it is what makes
// "Odoo QWeb PDF -> correctly rendered physical page" true — unlike a RAW
// spool of the PDF bytes.
//
// Safety properties:
//   - no shell is involved (no cmd.exe, no string-concatenated command line);
//   - the file path comes from os.CreateTemp inside a 0700 temp directory;
//   - the printer name is validated (no quotes/control chars) and passed as a
//     single quoted parameter to the handler;
//   - the spawned handler is waited on (SEE_MASK_NOCLOSEPROCESS +
//     WaitForSingleObject) so a failure is a real error, and the temp file is
//     only deleted after the handler has exited.

const (
	seeMaskNoCloseProcess = 0x00000040
	seeMaskFlagNoUI       = 0x00000400
	seeMaskNoAsync        = 0x00000100
	swHide                = 0
)

type shellExecuteInfoW struct {
	cbSize       uint32
	fMask        uint32
	hwnd         windows.Handle
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     windows.Handle
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    windows.Handle
	dwHotKey     uint32
	hIconOrMonitor windows.Handle
	hProcess     windows.Handle
}

var (
	modShell32          = windows.NewLazySystemDLL("shell32.dll")
	procShellExecuteExW = modShell32.NewProc("ShellExecuteExW")
)

// platformPrintPDF prints pdfPath on printerName through the registered PDF
// handler and waits for that handler to exit.
func platformPrintPDF(ctx context.Context, printerName, pdfPath string) error {
	verb, err := windows.UTF16PtrFromString("printto")
	if err != nil {
		return fmt.Errorf("encode printto verb: %w", err)
	}
	file, err := windows.UTF16PtrFromString(pdfPath)
	if err != nil {
		return fmt.Errorf("encode PDF path: %w", err)
	}
	// ValidatePDFPrinterName has already rejected embedded quotes, so this
	// parameter can never terminate early and inject further arguments.
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
	waitMillis := uint32(timeout / time.Millisecond)
	event, err := windows.WaitForSingleObject(info.hProcess, waitMillis)
	if err != nil {
		return fmt.Errorf("waiting for PDF handler of printer %q: %w", printerName, err)
	}
	if event == uint32(windows.WAIT_TIMEOUT) {
		return fmt.Errorf("PDF handler for printer %q did not finish within %s", printerName, timeout)
	}

	var exitCode uint32
	if err := windows.GetExitCodeProcess(info.hProcess, &exitCode); err != nil {
		return fmt.Errorf("reading PDF handler exit code for printer %q: %w", printerName, err)
	}
	if exitCode != 0 {
		return fmt.Errorf("PDF handler for printer %q exited with code %d", printerName, exitCode)
	}
	return nil
}
