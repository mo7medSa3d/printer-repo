//go:build windows

package printer

import (
	"context"
	"fmt"
	"log"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modWinspool          = syscall.NewLazyDLL("winspool.drv")
	procOpenPrinterW     = modWinspool.NewProc("OpenPrinterW")
	procClosePrinter     = modWinspool.NewProc("ClosePrinter")
	procStartDocPrinterW = modWinspool.NewProc("StartDocPrinterW")
	procStartPagePrinter = modWinspool.NewProc("StartPagePrinter")
	procWritePrinter     = modWinspool.NewProc("WritePrinter")
	procEndPagePrinter   = modWinspool.NewProc("EndPagePrinter")
	procEndDocPrinter    = modWinspool.NewProc("EndDocPrinter")
	procEnumPrintersW    = modWinspool.NewProc("EnumPrintersW")
	procGetPrinterW      = modWinspool.NewProc("GetPrinterW")
)

const (
	PRINTER_STATUS_PAUSED            = 0x00000001
	PRINTER_STATUS_ERROR             = 0x00000002
	PRINTER_STATUS_PAPER_JAM         = 0x00000008
	PRINTER_STATUS_PAPER_OUT         = 0x00000010
	PRINTER_STATUS_OFFLINE           = 0x00000080
	PRINTER_STATUS_USER_INTERVENTION = 0x00100000
	PRINTER_STATUS_DOOR_OPEN         = 0x00400000
)

type docInfo1 struct {
	pDocName    *uint16
	pOutputFile *uint16
	pDatatype   *uint16
}

// SpoolerPrinter interacts with the Windows Spooler API (winspool.drv).
//
// Win32 WritePrinter syscall is inherently synchronous in the Windows kernel driver.
// This package provides Caller Timeout Isolation via a bounded worker pool (maxSpoolerWorkers = 4)
// with fast-fail rejection (ERR_SPOOLER_POOL_SATURATED), rather than asynchronous kernel cancellation.
type SpoolerPrinter struct {
	Name        string
	SpoolerName string
	PDFPrint    PDFPrintFunc
	ProbeFunc   func(spoolerName string) string
	Timeout     time.Duration
}

func NewSpooler(spoolerName, displayName string) *SpoolerPrinter {
	name := spoolerName
	if displayName != "" {
		name = displayName
	}
	return &SpoolerPrinter{Name: name, SpoolerName: spoolerName}
}

// maxSpoolerWorkers bounds concurrent spooler operations.
// Win32 WritePrinter syscall is inherently synchronous in the Windows kernel driver.
// This package provides Caller Timeout Isolation via a bounded worker pool (maxSpoolerWorkers = 4)
// with fast-fail rejection (ERR_SPOOLER_POOL_SATURATED), rather than asynchronous kernel cancellation.
const maxSpoolerWorkers = 4

var spoolerWorkerSem = make(chan struct{}, maxSpoolerWorkers)

type spoolerTaskResult struct {
	written uint32
	jobID   uintptr
	err     error
}

func executeSpoolerSession(spoolerName string, data []byte, cancelNotice <-chan struct{}) spoolerTaskResult {
	printerNamePtr, err := syscall.UTF16PtrFromString(spoolerName)
	if err != nil {
		return spoolerTaskResult{err: fmt.Errorf("invalid spooler name %q: %w", spoolerName, err)}
	}

	var hPrinter syscall.Handle
	ret, _, err := procOpenPrinterW.Call(
		uintptr(unsafe.Pointer(printerNamePtr)),
		uintptr(unsafe.Pointer(&hPrinter)),
		0,
	)
	if ret == 0 {
		return spoolerTaskResult{err: fmt.Errorf("OpenPrinterW(%q) failed: %w", spoolerName, err)}
	}
	defer procClosePrinter.Call(uintptr(hPrinter))

	select {
	case <-cancelNotice:
		return spoolerTaskResult{err: fmt.Errorf("spooler job cancelled before doc start")}
	default:
	}

	docName, err := syscall.UTF16PtrFromString("Odoo Print Job")
	if err != nil {
		return spoolerTaskResult{err: fmt.Errorf("invalid document name: %w", err)}
	}
	dataType, err := syscall.UTF16PtrFromString("RAW")
	if err != nil {
		return spoolerTaskResult{err: fmt.Errorf("invalid datatype: %w", err)}
	}
	di := docInfo1{pDocName: docName, pDatatype: dataType}
	jobID, _, err := procStartDocPrinterW.Call(
		uintptr(hPrinter),
		1,
		uintptr(unsafe.Pointer(&di)),
	)
	if jobID == 0 {
		return spoolerTaskResult{err: fmt.Errorf("StartDocPrinterW(%q) failed: %w", spoolerName, err)}
	}
	defer func() {
		if _, _, e := procEndDocPrinter.Call(uintptr(hPrinter)); e != nil && e != syscall.Errno(0) {
			log.Printf("EndDocPrinter warning for %s: %v", spoolerName, e)
		}
	}()

	select {
	case <-cancelNotice:
		return spoolerTaskResult{jobID: jobID, err: fmt.Errorf("spooler job cancelled before page start")}
	default:
	}

	ret, _, err = procStartPagePrinter.Call(uintptr(hPrinter))
	if ret == 0 {
		return spoolerTaskResult{jobID: jobID, err: fmt.Errorf("StartPagePrinter(%q) failed: %w", spoolerName, err)}
	}
	defer procEndPagePrinter.Call(uintptr(hPrinter))

	var written uint32
	for int(written) < len(data) {
		select {
		case <-cancelNotice:
			if written > 0 {
				return spoolerTaskResult{
					written: written,
					jobID:   jobID,
					err:     fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: print cancelled after %d/%d bytes", written, len(data)),
				}
			}
			return spoolerTaskResult{jobID: jobID, err: fmt.Errorf("print cancelled")}
		default:
		}

		var bytesWritten uint32
		chunk := data[written:]
		r, _, writeErr := procWritePrinter.Call(
			uintptr(hPrinter),
			uintptr(unsafe.Pointer(&chunk[0])),
			uintptr(len(chunk)),
			uintptr(unsafe.Pointer(&bytesWritten)),
		)
		if r == 0 {
			if written > 0 {
				return spoolerTaskResult{
					written: written,
					jobID:   jobID,
					err:     fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: WritePrinter(%q) failed after %d/%d bytes: %w", spoolerName, written, len(data), writeErr),
				}
			}
			return spoolerTaskResult{written: written, jobID: jobID, err: fmt.Errorf("WritePrinter(%q) failed after %d/%d bytes: %w", spoolerName, written, len(data), writeErr)}
		}
		if bytesWritten == 0 {
			if written > 0 {
				return spoolerTaskResult{
					written: written,
					jobID:   jobID,
					err:     fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: WritePrinter(%q) wrote 0 bytes after %d/%d bytes", spoolerName, written, len(data)),
				}
			}
			return spoolerTaskResult{written: written, jobID: jobID, err: fmt.Errorf("WritePrinter(%q) wrote 0 bytes", spoolerName)}
		}
		written += bytesWritten
	}

	return spoolerTaskResult{written: written, jobID: jobID, err: nil}
}

func preFlightSpoolerCheck(spoolerName string) error {
	printerNamePtr, err := syscall.UTF16PtrFromString(spoolerName)
	if err != nil {
		return fmt.Errorf("invalid spooler name %q: %w", spoolerName, err)
	}

	var hPrinter syscall.Handle
	ret, _, lastErr := procOpenPrinterW.Call(
		uintptr(unsafe.Pointer(printerNamePtr)),
		uintptr(unsafe.Pointer(&hPrinter)),
		0,
	)
	if ret == 0 {
		return fmt.Errorf("%w: OpenPrinterW(%q) failed: %w", ErrPrinterOffline, spoolerName, lastErr)
	}
	defer procClosePrinter.Call(uintptr(hPrinter))

	minSize := uint32(unsafe.Sizeof(printerInfo2{}))
	var needed uint32
	procGetPrinterW.Call(
		uintptr(hPrinter),
		2,
		0,
		0,
		uintptr(unsafe.Pointer(&needed)),
	)
	if needed < minSize {
		// Fail-closed: winspool must provide at least enough bytes for printerInfo2
		return fmt.Errorf("%w: GetPrinterW(%q) returned invalid buffer size %d (minimum %d)", ErrPrinterNotReady, spoolerName, needed, minSize)
	}

	buf := make([]byte, needed)
	ret, _, lastErr = procGetPrinterW.Call(
		uintptr(hPrinter),
		2,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(needed),
		uintptr(unsafe.Pointer(&needed)),
	)
	if ret == 0 {
		// Fail-closed: cannot confirm printer readiness
		return fmt.Errorf("%w: GetPrinterW(%q) level 2 query failed: %w", ErrPrinterNotReady, spoolerName, lastErr)
	}

	if len(buf) < int(minSize) {
		return fmt.Errorf("%w: spooler buffer size %d smaller than printerInfo2 struct %d", ErrPrinterNotReady, len(buf), minSize)
	}

	pi := (*printerInfo2)(unsafe.Pointer(&buf[0]))
	if (pi.Status & PRINTER_STATUS_OFFLINE) != 0 {
		return fmt.Errorf("%w: spooler printer %q is offline (status 0x%08x)", ErrPrinterOffline, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_PAUSED) != 0 {
		return fmt.Errorf("%w: spooler printer %q is paused (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_ERROR) != 0 {
		return fmt.Errorf("%w: spooler printer %q is in error state (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_PAPER_JAM) != 0 {
		return fmt.Errorf("%w: spooler printer %q has a paper jam (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_USER_INTERVENTION) != 0 {
		return fmt.Errorf("%w: spooler printer %q requires user intervention (status 0x%08x)", ErrPrinterNotReady, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_DOOR_OPEN) != 0 {
		return fmt.Errorf("%w: spooler printer %q door or cover is open (status 0x%08x)", ErrPrinterCoverOpen, spoolerName, pi.Status)
	}
	if (pi.Status & PRINTER_STATUS_PAPER_OUT) != 0 {
		return fmt.Errorf("%w: spooler printer %q is out of paper (status 0x%08x)", ErrPrinterPaperOut, spoolerName, pi.Status)
	}
	return nil
}

// Print writes raw byte data directly to the Windows Spooler.
// Win32 WritePrinter syscall is inherently synchronous in the Windows kernel driver.
// This package provides Caller Timeout Isolation via a bounded worker pool (maxSpoolerWorkers = 4)
// with fast-fail rejection (ERR_SPOOLER_POOL_SATURATED), rather than asynchronous kernel cancellation.
func (p *SpoolerPrinter) Print(ctx context.Context, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("payload %d exceeds %d limit", len(data), maxPrintBytes)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	// Pre-flight check printer status before allocating worker slots
	if err := preFlightSpoolerCheck(p.SpoolerName); err != nil {
		return fmt.Errorf("pre-flight spooler check failed: %w", err)
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case spoolerWorkerSem <- struct{}{}:
	default:
		return fmt.Errorf("ERR_SPOOLER_POOL_SATURATED: all spooler worker slots occupied (%d/%d)", maxSpoolerWorkers, maxSpoolerWorkers)
	}

	resultCh := make(chan spoolerTaskResult, 1)
	cancelNotice := make(chan struct{})

	go func() {
		defer func() {
			<-spoolerWorkerSem
		}()
		resultCh <- executeSpoolerSession(p.SpoolerName, data, cancelNotice)
	}()

	select {
	case <-ctx.Done():
		close(cancelNotice)
		// Return immediately without touching Win32 handle.
		// Worker manages its own handle lifecycle and closes it safely upon return.
		return fmt.Errorf("spooler print cancelled: %w", ctx.Err())
	case res := <-resultCh:
		if res.err != nil {
			return res.err
		}
		log.Printf("Spooler printed %d bytes to %s (job %d)", res.written, p.SpoolerName, res.jobID)
		return nil
	}
}

func (p *SpoolerPrinter) SupportsKind(kind string) bool {
	switch NormalizeKind(kind) {
	case KindRaw, KindESCPOS, KindPDF, KindImage:
		return true
	default:
		return false
	}
}

func (p *SpoolerPrinter) PrintDocument(ctx context.Context, doc Document) error {
	switch NormalizeKind(doc.Kind) {
	case KindPDF:
		return PrintPDF(ctx, p.SpoolerName, doc, p.PDFPrint)
	case KindImage:
		pdf, err := JPEGToPDF(doc.Data)
		if err != nil {
			return fmt.Errorf("render image for Windows spooler: %w", err)
		}
		return PrintPDF(ctx, p.SpoolerName, Document{Kind: KindPDF, Data: pdf, JobID: doc.JobID}, p.PDFPrint)
	case KindRaw, KindESCPOS:
		return p.Print(ctx, doc.Data)
	default:
		return CapabilityMismatchf("spooler printer %q cannot render %s payloads", p.SpoolerName, NormalizeKind(doc.Kind))
	}
}

func (p *SpoolerPrinter) Test(ctx context.Context) error {
	return p.Print(ctx, []byte("\x1b\x40Spooler Test Print from Odoo Agent\nPrinter: "+p.SpoolerName+"\n\n\x1d\x56\x01"))
}

func (p *SpoolerPrinter) Status() string {
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = 1500 * time.Millisecond
	}
	resCh := make(chan string, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("Spooler status probe panic for %s: %v", p.SpoolerName, r)
				resCh <- "error"
			}
		}()
		if p.ProbeFunc != nil {
			resCh <- p.ProbeFunc(p.SpoolerName)
			return
		}
		printerNamePtr, err := syscall.UTF16PtrFromString(p.SpoolerName)
		if err != nil {
			resCh <- "error"
			return
		}
		var hPrinter syscall.Handle
		ret, _, _ := procOpenPrinterW.Call(
			uintptr(unsafe.Pointer(printerNamePtr)),
			uintptr(unsafe.Pointer(&hPrinter)),
			0,
		)
		if ret == 0 {
			resCh <- "offline"
			return
		}
		procClosePrinter.Call(uintptr(hPrinter))
		resCh <- "online"
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case st := <-resCh:
		return st
	case <-timer.C:
		log.Printf("WARNING: Spooler status probe timed out for %q after %v", p.SpoolerName, timeout)
		return "spooler_rpc_unresponsive"
	}
}

type printerInfo2 struct {
	pServerName          *uint16
	pPrinterName         *uint16
	pShareName           *uint16
	pPortName            *uint16
	pDriverName          *uint16
	pComment             *uint16
	pLocation            *uint16
	pDevMode             uintptr
	pSepFile             *uint16
	pPrintProcessor      *uint16
	pDatatype            *uint16
	pParameters          *uint16
	pSecurityDescriptor  uintptr
	Attributes           uint32
	Priority             uint32
	DefaultPriority      uint32
	StartTime            uint32
	UntilTime            uint32
	Status               uint32
	cJobs                uint32
	AveragePPM           uint32
}

func utf16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	return windows.UTF16PtrToString(p)
}

func EnumSpoolerPrinters() ([]DeviceInfo, error) {
	const (
		printerEnumLocal       = 0x00000002
		printerEnumConnections = 0x00000004
		level                  = 2
	)
	flags := uintptr(printerEnumLocal | printerEnumConnections)
	log.Printf("[discovery] starting Windows spooler discovery (EnumPrintersW level %d, flags 0x%x)", level, flags)

	var needed, returned uint32
	procEnumPrintersW.Call(
		flags,
		0,
		uintptr(level),
		0,
		0,
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&returned)),
	)
	if needed == 0 {
		return nil, nil
	}

	buf := make([]byte, needed)
	ret, _, lastErr := procEnumPrintersW.Call(
		flags,
		0,
		uintptr(level),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(needed),
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&returned)),
	)
	if ret == 0 {
		if needed > uint32(len(buf)) {
			buf = make([]byte, needed)
			ret, _, lastErr = procEnumPrintersW.Call(
				flags,
				0,
				uintptr(level),
				uintptr(unsafe.Pointer(&buf[0])),
				uintptr(needed),
				uintptr(unsafe.Pointer(&needed)),
				uintptr(unsafe.Pointer(&returned)),
			)
		}
		if ret == 0 {
			return nil, fmt.Errorf("EnumPrintersW failed: %v", lastErr)
		}
	}

	structSize := unsafe.Sizeof(printerInfo2{})
	if uintptr(returned)*structSize > uintptr(len(buf)) {
		returned = uint32(uintptr(len(buf)) / structSize)
	}

	out := make([]DeviceInfo, 0, returned)
	for i := uint32(0); i < returned; i++ {
		offset := uintptr(i) * structSize
		pi := (*printerInfo2)(unsafe.Pointer(uintptr(unsafe.Pointer(&buf[0])) + offset))
		name := utf16PtrToString(pi.pPrinterName)
		if name == "" {
			continue
		}
		out = append(out, DeviceInfo{
			Name:           name,
			Protocol:       "spooler",
			ConnectionType: "spooler",
			Endpoint:       name,
		})
	}
	return out, nil
}
