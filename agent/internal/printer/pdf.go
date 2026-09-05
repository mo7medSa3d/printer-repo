package printer

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"
)

// PDF printing.
//
// A PDF is a *document*, not a byte stream: handing it to a RAW spooler job
// (StartDocPrinterW datatype "RAW") only works for the rare printer whose
// firmware understands PDF directly. Everything else prints pages of
// gibberish. This file implements a real PDF path:
//
//	validate PDF bytes -> secure temp file (0600, random name, private dir)
//	-> PDF-aware print submission -> wait for completion -> delete temp file
//
// The submission itself is platform specific:
//
//	windows  — ShellExecuteExW with the "printto" verb, i.e. the registered
//	           PDF handler renders the document through the Windows printer
//	           driver (pdf_windows.go). No shell, no string concatenation.
//	all OSes — an explicitly configured PDF helper command
//	           (pdf_print_command in agent.yaml) executed with argv slices.
//	other    — an explicit "not supported" error (pdf_other.go). PDF is never
//	           downgraded to RAW.
const (
	pdfHeaderMarker = "%PDF-"
	pdfEOFMarker    = "%%EOF"
	// The header must appear at the very start of the file; a small window is
	// tolerated only for a UTF-8 BOM / stray whitespace written by exporters.
	pdfHeaderSearchWindow = 64
	// %%EOF is the last token of a well-formed PDF; some writers append a few
	// bytes of padding/newlines after it.
	pdfEOFSearchWindow = 4096
	// Upper bound for one PDF submission (rendering + spooling by the handler).
	defaultPDFPrintTimeout = 120 * time.Second
)

type PDFPrintFunc func(ctx context.Context, printerName, pdfPath string) error

var pdfHelperCommand []string

func SetPDFHelperCommand(argv []string) {
	if len(argv) == 0 {
		pdfHelperCommand = nil
		return
	}
	cp := make([]string, len(argv))
	copy(cp, argv)
	pdfHelperCommand = cp
}

func PDFHelperCommand() []string {
	if pdfHelperCommand == nil {
		return nil
	}
	cp := make([]string, len(pdfHelperCommand))
	copy(cp, pdfHelperCommand)
	return cp
}

func ValidatePDF(data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty PDF payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("PDF payload %d bytes exceeds %d limit", len(data), maxPrintBytes)
	}
	head := data
	if len(head) > pdfHeaderSearchWindow {
		head = head[:pdfHeaderSearchWindow]
	}
	if !bytes.Contains(head, []byte(pdfHeaderMarker)) {
		return fmt.Errorf("payload is not a PDF document (missing %s header)", pdfHeaderMarker)
	}
	tail := data
	if len(tail) > pdfEOFSearchWindow {
		tail = tail[len(tail)-pdfEOFSearchWindow:]
	}
	if !bytes.Contains(tail, []byte(pdfEOFMarker)) {
		return fmt.Errorf("truncated or malformed PDF document (missing %s trailer)", pdfEOFMarker)
	}
	return nil
}

func ValidatePDFPrinterName(name string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("printer name is empty")
	}
	if len(name) > 220 {
		return fmt.Errorf("printer name is too long (%d bytes)", len(name))
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("printer name contains a control character (0x%02x)", r)
		}
	}
	if strings.ContainsAny(name, "\"") {
		return fmt.Errorf("printer name contains a quote character, which is not a valid Windows printer name")
	}
	return nil
}

func writeSecurePDFTemp(data []byte) (string, func(), error) {
	dir, err := os.MkdirTemp("", "odoo-print-pdf-")
	if err != nil {
		return "", func() {}, fmt.Errorf("create temp dir for PDF: %w", err)
	}
	cleanup := func() {
		if err := os.RemoveAll(dir); err != nil {
			log.Printf("WARNING: failed to remove temporary PDF directory %s: %v", dir, err)
		}
	}

	f, err := os.CreateTemp(dir, "job-*.pdf")
	if err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("create temp PDF file: %w", err)
	}
	path := f.Name()
	if err := f.Chmod(0o600); err != nil && !isWindowsChmodUnsupported(err) {
		f.Close()
		cleanup()
		return "", func() {}, fmt.Errorf("restrict temp PDF permissions: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		cleanup()
		return "", func() {}, fmt.Errorf("write temp PDF: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		cleanup()
		return "", func() {}, fmt.Errorf("flush temp PDF: %w", err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("close temp PDF: %w", err)
	}
	return path, cleanup, nil
}

func isWindowsChmodUnsupported(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "not supported")
}

func buildPDFHelperArgs(template []string, printerName, pdfPath string) ([]string, error) {
	if len(template) == 0 {
		return nil, fmt.Errorf("no PDF helper command configured")
	}
	out := make([]string, 0, len(template))
	sawFile := false
	for _, part := range template {
		switch part {
		case "{printer}":
			out = append(out, printerName)
		case "{file}":
			out = append(out, pdfPath)
			sawFile = true
		default:
			out = append(out, part)
		}
	}
	if !sawFile {
		return nil, fmt.Errorf("PDF helper command must contain the {file} placeholder")
	}
	return out, nil
}

func runPDFHelper(ctx context.Context, template []string, printerName, pdfPath string) error {
	argv, err := buildPDFHelperArgs(template, printerName, pdfPath)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg != "" {
			return fmt.Errorf("PDF helper %s failed: %w: %s", argv[0], err, msg)
		}
		return fmt.Errorf("PDF helper %s failed: %w", argv[0], err)
	}
	return nil
}

// PrintPDF gives the PDF submission its own 120-second deadline while still
// propagating caller cancellation. This avoids accidentally inheriting a
// nearly-expired print-job deadline and collapsing a valid PDF budget.
func PrintPDF(ctx context.Context, printerName string, doc Document, printFn PDFPrintFunc) error {
	if err := ValidatePDF(doc.Data); err != nil {
		return err
	}
	if err := ValidatePDFPrinterName(printerName); err != nil {
		return fmt.Errorf("refusing to print PDF: %w", err)
	}

	if printFn == nil {
		if helper := PDFHelperCommand(); len(helper) > 0 {
			printFn = func(ctx context.Context, name, path string) error {
				return runPDFHelper(ctx, helper, name, path)
			}
		} else {
			printFn = platformPrintPDF
		}
	}

	path, cleanup, err := writeSecurePDFTemp(doc.Data)
	if err != nil {
		return err
	}
	defer cleanup()

	// Keep cancellation semantics from the parent job, but do not inherit its
	// potentially nearly-expired deadline. The helper gets a fresh full budget.
	printCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), defaultPDFPrintTimeout)
	defer cancel()
	parentDone := make(chan struct{})
	defer close(parentDone)
	go func() {
		select {
		case <-ctx.Done():
			cancel()
		case <-parentDone:
		case <-printCtx.Done():
		}
	}()

	if err := printFn(printCtx, printerName, path); err != nil {
		return fmt.Errorf("PDF print on %q failed: %w", printerName, err)
	}
	log.Printf("PDF job %s (%d bytes) submitted to printer %q via PDF path", doc.JobID, len(doc.Data), printerName)
	return nil
}
