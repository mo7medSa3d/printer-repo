package printer

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Regression tests for the PDF printing pipeline (PART 2 of the production
// fix): a PDF must travel through a PDF-aware path, never as opaque RAW bytes,
// and the temporary file it needs must never leak or be attacker-steerable.

func validPDF() []byte {
	// Minimal but structurally complete one-page PDF.
	return []byte("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
		"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
		"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n" +
		"trailer<</Root 1 0 R>>\n%%EOF\n")
}

// --- Test 7: valid PDF payload passes validation -------------------------

func TestValidPDFPassesValidation(t *testing.T) {
	if err := ValidatePDF(validPDF()); err != nil {
		t.Fatalf("valid PDF rejected: %v", err)
	}
	// A BOM/leading newline written by some exporters is still accepted.
	withPreamble := append([]byte("\n"), validPDF()...)
	if err := ValidatePDF(withPreamble); err != nil {
		t.Fatalf("PDF with leading newline rejected: %v", err)
	}
	// Trailing padding after %%EOF is tolerated.
	padded := append(validPDF(), bytes.Repeat([]byte("\n"), 32)...)
	if err := ValidatePDF(padded); err != nil {
		t.Fatalf("PDF with trailing padding rejected: %v", err)
	}
}

// --- Test 8: invalid PDF payloads are rejected ---------------------------

func TestInvalidPDFIsRejected(t *testing.T) {
	cases := map[string][]byte{
		"empty":           {},
		"escpos bytes":    []byte("\x1b\x40Hello receipt\n\x1d\x56\x01"),
		"missing header":  []byte("not a pdf at all but ends correctly\n%%EOF\n"),
		"missing eof":     []byte("%PDF-1.7\n1 0 obj<<>>endobj\n"),
		"header too late": append(bytes.Repeat([]byte("A"), 128), validPDF()...),
	}
	for name, data := range cases {
		if err := ValidatePDF(data); err == nil {
			t.Fatalf("%s: expected validation error, got nil", name)
		}
	}

	oversized := make([]byte, maxPrintBytes+1)
	copy(oversized, []byte("%PDF-1.4\n"))
	copy(oversized[len(oversized)-6:], []byte("%%EOF\n"))
	if err := ValidatePDF(oversized); err == nil {
		t.Fatal("oversized PDF must be rejected")
	}
}

// --- Test 9: PDF to a PDF-capable printer uses the PDF path --------------

type recordingPDFPath struct {
	mu          sync.Mutex
	calls       int
	printerName string
	path        string
	existed     bool
	contents    []byte
}

func (r *recordingPDFPath) fn(_ context.Context, printerName, pdfPath string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	r.printerName = printerName
	r.path = pdfPath
	if data, err := os.ReadFile(pdfPath); err == nil {
		r.existed = true
		r.contents = data
	}
	return nil
}

func TestPDFUsesPDFPrintPathOnPDFCapablePrinter(t *testing.T) {
	rec := &recordingPDFPath{}
	sp := NewSpooler("Office Laser", "Office Laser")
	sp.PDFPrint = rec.fn

	if !SupportsKind(sp, KindPDF) {
		t.Fatal("spooler backend must advertise PDF support")
	}

	doc := Document{Kind: KindPDF, Data: validPDF(), JobID: "job_pdf_1"}
	if err := PrintDocument(context.Background(), sp, doc); err != nil {
		t.Fatalf("PDF print failed: %v", err)
	}
	if rec.calls != 1 {
		t.Fatalf("expected exactly 1 PDF submission, got %d", rec.calls)
	}
	if rec.printerName != "Office Laser" {
		t.Fatalf("PDF path got printer %q", rec.printerName)
	}
	if !strings.HasSuffix(strings.ToLower(rec.path), ".pdf") {
		t.Fatalf("PDF must be materialized as a .pdf file, got %q", rec.path)
	}
	if !rec.existed {
		t.Fatal("temp PDF file did not exist while the print path ran")
	}
	if !bytes.Equal(rec.contents, doc.Data) {
		t.Fatal("temp PDF contents differ from the payload bytes")
	}
}

// --- Test 10: PDF to an ESC/POS-only printer -> CAPABILITY_MISMATCH ------

func TestPDFToESCPOSOnlyPrinterIsCapabilityMismatch(t *testing.T) {
	escposOnly := &NetworkPrinter{Address: "127.0.0.1:9100"}
	if SupportsKind(escposOnly, KindPDF) {
		t.Fatal("raw TCP printer must not advertise PDF support")
	}

	err := PrintDocument(context.Background(), escposOnly, Document{Kind: KindPDF, Data: validPDF(), JobID: "job_pdf_2"})
	if err == nil {
		t.Fatal("PDF to an ESC/POS byte-stream printer must fail")
	}
	if !IsCapabilityMismatch(err) {
		t.Fatalf("expected CAPABILITY_MISMATCH, got %v", err)
	}
	if !strings.Contains(err.Error(), "CAPABILITY_MISMATCH") {
		t.Fatalf("error text must carry the CAPABILITY_MISMATCH token, got %q", err.Error())
	}

	// Same for a raw USB endpoint.
	usb := &USBPrinter{ID: "usb1", Name: "USB Thermal"}
	if SupportsKind(usb, KindPDF) {
		t.Fatal("raw USB printer must not advertise PDF support")
	}
}

// --- Test 11: RAW payload keeps using the RAW path -----------------------

func TestRawPayloadUsesRawTransport(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	received := make(chan []byte, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 256)
		n, _ := conn.Read(buf)
		received <- append([]byte(nil), buf[:n]...)
	}()

	p := &NetworkPrinter{Address: ln.Addr().String()}
	raw := []byte("RAW-BYTES-1234")
	if err := PrintDocument(context.Background(), p, Document{Kind: KindRaw, Data: raw, JobID: "job_raw"}); err != nil {
		t.Fatalf("raw print failed: %v", err)
	}
	select {
	case got := <-received:
		if !bytes.Equal(got, raw) {
			t.Fatalf("raw transport altered the bytes: %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("raw bytes never reached the TCP printer")
	}
}

// --- Test 12: ESC/POS payload keeps using the ESC/POS byte path ----------

func TestESCPOSPayloadUsesByteStreamPathNotPDFPath(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	received := make(chan []byte, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 256)
		n, _ := conn.Read(buf)
		received <- append([]byte(nil), buf[:n]...)
	}()

	escpos := []byte("\x1b\x40Receipt line\n\x1d\x56\x01")
	p := &NetworkPrinter{Address: ln.Addr().String()}
	if err := PrintDocument(context.Background(), p, Document{Kind: KindESCPOS, Data: escpos, JobID: "job_escpos"}); err != nil {
		t.Fatalf("escpos print failed: %v", err)
	}
	select {
	case got := <-received:
		if !bytes.Equal(got, escpos) {
			t.Fatalf("escpos transport altered the bytes: %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("escpos bytes never reached the TCP printer")
	}

	// An ESC/POS job on a PDF-capable spooler must NOT take the PDF path.
	rec := &recordingPDFPath{}
	sp := NewSpooler("Office Laser", "Office Laser")
	sp.PDFPrint = rec.fn
	if err := PrintDocument(context.Background(), sp, Document{Kind: KindESCPOS, Data: escpos, JobID: "job_escpos_2"}); err != nil {
		t.Fatalf("escpos on spooler failed: %v", err)
	}
	if rec.calls != 0 {
		t.Fatalf("ESC/POS payload must not use the PDF path (got %d PDF submissions)", rec.calls)
	}
}

// --- Tests 13 & 14: temp file removal on success and failure -------------

func TestTempPDFFileRemovedAfterSuccess(t *testing.T) {
	var captured string
	sp := NewSpooler("Office Laser", "Office Laser")
	sp.PDFPrint = func(_ context.Context, _ string, path string) error {
		captured = path
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("temp PDF missing during print: %v", err)
		}
		return nil
	}

	if err := PrintDocument(context.Background(), sp, Document{Kind: KindPDF, Data: validPDF(), JobID: "job_cleanup_ok"}); err != nil {
		t.Fatalf("PDF print failed: %v", err)
	}
	if captured == "" {
		t.Fatal("PDF path was never invoked")
	}
	if _, err := os.Stat(captured); !os.IsNotExist(err) {
		t.Fatalf("temp PDF %s still exists after success (err=%v)", captured, err)
	}
	if _, err := os.Stat(filepath.Dir(captured)); !os.IsNotExist(err) {
		t.Fatalf("temp PDF directory %s still exists after success", filepath.Dir(captured))
	}
}

func TestTempPDFFileRemovedAfterFailure(t *testing.T) {
	var captured string
	sp := NewSpooler("Office Laser", "Office Laser")
	sp.PDFPrint = func(_ context.Context, _ string, path string) error {
		captured = path
		return errors.New("printer jammed")
	}

	err := PrintDocument(context.Background(), sp, Document{Kind: KindPDF, Data: validPDF(), JobID: "job_cleanup_fail"})
	if err == nil {
		t.Fatal("failing PDF submission must return an error")
	}
	if !strings.Contains(err.Error(), "printer jammed") {
		t.Fatalf("real printer error must propagate, got %v", err)
	}
	if captured == "" {
		t.Fatal("PDF path was never invoked")
	}
	if _, err := os.Stat(captured); !os.IsNotExist(err) {
		t.Fatalf("temp PDF %s still exists after failure (err=%v)", captured, err)
	}
	if _, err := os.Stat(filepath.Dir(captured)); !os.IsNotExist(err) {
		t.Fatalf("temp PDF directory %s still exists after failure", filepath.Dir(captured))
	}
}

// --- Test 15: printer name / metadata cannot inject commands -------------

func TestPrinterNameCannotInjectCommands(t *testing.T) {
	malicious := []string{
		`Printer" & del C:\Windows\System32 & echo "`,
		"Printer\"\r\nshutdown -s",
		"Printer\x00evil",
		"Printer\nrm -rf /",
	}
	for _, name := range malicious {
		if err := ValidatePDFPrinterName(name); err == nil {
			t.Fatalf("malicious printer name accepted: %q", name)
		}
		sp := NewSpooler(name, name)
		sp.PDFPrint = func(_ context.Context, _ string, _ string) error {
			t.Fatalf("PDF submission must never run for printer name %q", name)
			return nil
		}
		if err := PrintDocument(context.Background(), sp, Document{Kind: KindPDF, Data: validPDF(), JobID: "job_inject"}); err == nil {
			t.Fatalf("PDF print with malicious printer name %q must fail", name)
		}
	}

	// Legitimate names with spaces/ampersands stay usable and remain exactly
	// ONE argv element — the helper is executed via exec, never via a shell.
	name := "Front Desk & Kitchen HP-1234"
	if err := ValidatePDFPrinterName(name); err != nil {
		t.Fatalf("legitimate printer name rejected: %v", err)
	}
	argv, err := buildPDFHelperArgs([]string{"/usr/bin/helper", "-print-to", "{printer}", "-silent", "{file}"}, name, "/tmp/x.pdf")
	if err != nil {
		t.Fatalf("buildPDFHelperArgs: %v", err)
	}
	want := []string{"/usr/bin/helper", "-print-to", name, "-silent", "/tmp/x.pdf"}
	if len(argv) != len(want) {
		t.Fatalf("argv length mismatch: %v", argv)
	}
	for i := range want {
		if argv[i] != want[i] {
			t.Fatalf("argv[%d] = %q, want %q", i, argv[i], want[i])
		}
	}
	// A payload-controlled value can never become extra arguments.
	argv, err = buildPDFHelperArgs([]string{"/usr/bin/helper", "{printer}", "{file}"}, "a b; rm -rf /", "/tmp/x.pdf")
	if err != nil {
		t.Fatalf("buildPDFHelperArgs: %v", err)
	}
	if len(argv) != 3 || argv[1] != "a b; rm -rf /" {
		t.Fatalf("shell metacharacters split into separate arguments: %#v", argv)
	}

	// A helper template without {file} is rejected instead of printing nothing.
	if _, err := buildPDFHelperArgs([]string{"/usr/bin/helper", "{printer}"}, name, "/tmp/x.pdf"); err == nil {
		t.Fatal("helper template without {file} must be rejected")
	}
}

// The PDF paths must never build a command line for a shell interpreter.
func TestPDFPathsNeverUseAShell(t *testing.T) {
	for _, file := range []string{"pdf.go", "pdf_windows.go", "pdf_other.go"} {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		src := string(data)
		for _, forbidden := range []string{`"sh", "-c"`, `"bash"`, `"cmd", "/C"`, `"cmd.exe"`, "powershell"} {
			if strings.Contains(strings.ToLower(src), strings.ToLower(forbidden)) {
				t.Fatalf("%s must not invoke a shell (found %q)", file, forbidden)
			}
		}
	}
}

// Every backend must declare its supported document kinds so the gateway can
// route correctly (capabilities.supported_protocols in the heartbeat).
func TestSupportedKindsPerBackend(t *testing.T) {
	cases := []struct {
		name  string
		p     Printer
		kinds []string
	}{
		{"raw tcp", &NetworkPrinter{Address: "127.0.0.1:9100"}, []string{KindRaw, KindESCPOS}},
		{"spooler", NewSpooler("Office Laser", "Office Laser"), []string{KindRaw, KindESCPOS, KindPDF}},
		{"usb", &USBPrinter{ID: "u", Name: "USB"}, []string{KindRaw, KindESCPOS}},
	}
	for _, c := range cases {
		got := SupportedKinds(c.p)
		if fmt.Sprint(got) != fmt.Sprint(c.kinds) {
			t.Fatalf("%s: supported kinds = %v, want %v", c.name, got, c.kinds)
		}
	}

	ipp, err := NewIPPPrinter("ipp://127.0.0.1:631/ipp/print", "IPP")
	if err != nil {
		t.Fatalf("NewIPPPrinter: %v", err)
	}
	if got := SupportedKinds(ipp); fmt.Sprint(got) != fmt.Sprint([]string{KindRaw, KindESCPOS, KindPDF}) {
		t.Fatalf("ipp: supported kinds = %v", got)
	}
	if format, ok := ippDocumentFormatFor(KindPDF); !ok || format != ippFormatPDF {
		t.Fatalf("IPP must send PDF as %s, got %q (ok=%v)", ippFormatPDF, format, ok)
	}
	if format, ok := ippDocumentFormatFor(KindESCPOS); !ok || format != ippFormatOctetStream {
		t.Fatalf("IPP must send ESC/POS as %s, got %q (ok=%v)", ippFormatOctetStream, format, ok)
	}
}
