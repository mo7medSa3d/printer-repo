//go:build windows

package printer

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
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
// Win32 WritePrinter is inherently synchronous in the Windows kernel driver
// and cannot be cancelled: a wedged spooler RPC blocks the worker goroutine
// until it returns, however long that takes. Containment is therefore
// per-printer (sessionMu): a wedged printer can only ever tie up its OWN
// session — never other printers'. Cross-printer burst protection comes from
// the agent's job executor cap, which the spooler routinely absorbs.
type SpoolerPrinter struct {
	Name        string
	SpoolerName string
	PDFPrint    PDFPrintFunc
	ProbeFunc   func(spoolerName string) string
	Timeout     time.Duration
	// preflightActive single-flights the readiness probe per printer: at
	// most one helper goroutine may ever be stuck inside Win32 for this
	// printer. Only pointer receivers ever exist (see NewSpooler and all
	// call sites), so atomic access is race-safe.
	preflightActive atomic.Bool
	// sessionMu serializes full print sessions per printer. A session that
	// wedges inside synchronous WritePrinter holds this mutex (not a shared
	// pool slot), so repeated Prints against the SAME wedged printer fail
	// fast via TryLock below while every OTHER printer proceeds normally.
	// sync.Mutex is safe as a zero value, so struct literals in tests and
	// all constructors behave identically.
	sessionMu sync.Mutex
}

func NewSpooler(spoolerName, displayName string) *SpoolerPrinter {
	name := spoolerName
	if displayName != "" {
		name = displayName
	}
	return &SpoolerPrinter{Name: name, SpoolerName: spoolerName}
}

// preflightTimeout bounds the readiness probe. Win32 OpenPrinterW/GetPrinterW
// expose NO timeout of their own and block indefinitely against a wedged
// spooler RPC, so the caller must bound them. 10s is generous: a healthy
// local spooler answers in single-digit milliseconds; anything slower is
// already an unresponsive control plane. A timeout here is provably
// pre-dispatch (status queries can never spool a document), so it stays a
// plain typed failure, never an unknown outcome.
const preflightTimeout = 10 * time.Second

// boundedPreflight runs one readiness check with single-flight semantics
// for this printer: if a previous check is still stuck inside Win32, fail
// fast instead of spawning another helper goroutine. Without this, every
// timed-out Print against a wedged spooler would leak one more blocked
// helper (each Print gets its own, because the stuck one never returns to
// clear the way) — unbounded accumulation over hours of steady job flow.
// The flag clears when the stuck helper's check finally returns, so
// recovery after a transient stall is automatic, with no restart and no
// operator action. A refused call is a plain pre-dispatch failure: no
// document bytes were ever submitted.
func (p *SpoolerPrinter) boundedPreflight(ctx context.Context, timeout time.Duration, check func() error) error {
	if !p.preflightActive.CompareAndSwap(false, true) {
		return fmt.Errorf("%w: readiness probe for %q already in progress (previous probe stuck in spooler RPC)", ErrPrinterNotReady, p.SpoolerName)
	}
	return runPreflightBounded(p.SpoolerName, timeout, ctx, func() error {
		defer p.preflightActive.Store(false)
		return check()
	})
}

// runPreflightBounded executes a readiness check on a helper goroutine and
// bounds the CALLER: it returns when the check completes, when ctx is done,
// or when the hard timeout elapses — whichever comes first. The helper owns
// its handle lifecycle end-to-end (opened and closed inside the worker) and
// reports through a buffered channel, so a stuck check cannot deadlock the
// caller, cannot be double-closed, and cannot leak shared state; at most one
// helper exists per Print call, and Print calls are already bounded by the
// agent's job executor plus the per-printer session mutex.
func runPreflightBounded(displayName string, timeout time.Duration, ctx context.Context, check func() error) error {
	type outcome struct{ err error }
	done := make(chan outcome, 1)
	go func() { done <- outcome{check()} }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case r := <-done:
		return r.err
	case <-ctx.Done():
		return fmt.Errorf("readiness probe for %q cancelled before dispatch (no bytes sent): %w", displayName, ctx.Err())
	case <-timer.C:
		return fmt.Errorf("%w: readiness probe for %q timed out after %v (spooler RPC unresponsive; fail-closed, no bytes sent)", ErrPrinterNotReady, displayName, timeout)
	}
}

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
	// EndDocPrinter must run on every path after StartDocPrinterW succeeded.
	// On the success path it is called explicitly so its verdict can be
	// classified honestly: a failed EndDocPrinter may cause the spooler to
	// discard the job even though WritePrinter accepted every byte.
	docCompleted := false
	defer func() {
		if docCompleted {
			return
		}
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
	pageCompleted := false
	defer func() {
		if !pageCompleted {
			procEndPagePrinter.Call(uintptr(hPrinter))
		}
	}()

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

	pageCompleted = true
	procEndPagePrinter.Call(uintptr(hPrinter))

	docCompleted = true
	if _, _, endErr := procEndDocPrinter.Call(uintptr(hPrinter)); endErr != nil && endErr != syscall.Errno(0) {
		// WritePrinter accepted all bytes, but the Win32 doc session did not
		// close cleanly: the spooler may discard the job. "Printed" would be
		// a false confirmation, so the outcome stays ambiguous.
		return spoolerTaskResult{
			written: written,
			jobID:   jobID,
			err:     MarkUnknown("spooler session for %q failed to close after writing %d/%d bytes (submission state unknown): %v", spoolerName, written, len(data), endErr),
		}
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
// Win32 WritePrinter is inherently synchronous: a wedged call blocks until
// Win32 returns, so caller-side timeouts isolate the CALLER (see the select
// below) while the per-printer session mutex isolates OTHER printers.
// tryBeginSession acquires this printer's session slot with a bounded waiting lock (15-second timeout).
// A refusal is a plain pre-dispatch failure: no document bytes were ever submitted.
func (p *SpoolerPrinter) tryBeginSession(ctx context.Context) error {
	const lockTimeout = 15 * time.Second
	deadline := time.NewTimer(lockTimeout)
	defer deadline.Stop()

	// Fast path
	if p.sessionMu.TryLock() {
		return nil
	}

	// Bounded wait loop
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("%w: spooler session lock for %q timed out after %v", ErrPrinterNotReady, p.SpoolerName, lockTimeout)
		case <-ticker.C:
			if p.sessionMu.TryLock() {
				return nil
			}
		}
	}
}

func (p *SpoolerPrinter) endSession() {
	p.sessionMu.Unlock()
}

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

	// Pre-flight check printer status before allocating worker slots.
	// The check itself is bounded (see runPreflightBounded): a wedged
	// spooler RPC must not wedge the caller before the worker machinery
	// below even starts. Single-flight (see boundedPreflight) additionally
	// guarantees repeated timeouts cannot accumulate stuck helpers.
	if err := p.boundedPreflight(ctx, preflightTimeout, func() error {
		return preFlightSpoolerCheck(p.SpoolerName)
	}); err != nil {
		return fmt.Errorf("pre-flight spooler check failed: %w", err)
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	// Serialize full sessions per printer with a bounded 15s wait.
	if err := p.tryBeginSession(ctx); err != nil {
		return err
	}
	defer p.endSession()

	resultCh := make(chan spoolerTaskResult, 1)
	cancelNotice := make(chan struct{})

	go func() {
		resultCh <- executeSpoolerSession(p.SpoolerName, data, cancelNotice)
	}()

	select {
	case <-ctx.Done():
		close(cancelNotice)
		// The worker may already be past WritePrinter. Wait a bounded time
		// for its authoritative result; whatever it reports (including
		// UNKNOWN_PARTIAL_DELIVERY from a mid-write cancel) is returned as
		// is. If the Win32 call never returns, the outcome is unknown BY
		// DEFINITION and must be reported as such — never as a clean
		// not-printed failure, which would invite a duplicate reprint.
		select {
		case res := <-resultCh:
			return res.err
		case <-time.After(30 * time.Second):
			return MarkUnknown("spooler session on %q still active after cancellation (bytes written unknown): %v", p.SpoolerName, ctx.Err())
		}
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
		// Evaluate the same PRINTER_INFO_2 status bits as the dispatch
		// preflight: a queue that merely OPENS (paused, error, jam, door
		// open, paper out) must not report "online" or the gateway keeps
		// routing jobs at a printer that refuses them. Only the gateway's
		// status vocabulary is returned (online/offline/error); anything
		// the probe cannot determine surfaces as "error" here and the
		// outer timeout below stays "spooler_rpc_unresponsive" (both
		// normalize away from online gateway-side).
		if err := preFlightSpoolerCheck(p.SpoolerName); err != nil {
			if errors.Is(err, ErrPrinterOffline) {
				resCh <- "offline"
			} else {
				resCh <- "error"
			}
			return
		}
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
	pServerName         *uint16
	pPrinterName        *uint16
	pShareName          *uint16
	pPortName           *uint16
	pDriverName         *uint16
	pComment            *uint16
	pLocation           *uint16
	pDevMode            uintptr
	pSepFile            *uint16
	pPrintProcessor     *uint16
	pDatatype           *uint16
	pParameters         *uint16
	pSecurityDescriptor uintptr
	Attributes          uint32
	Priority            uint32
	DefaultPriority     uint32
	StartTime           uint32
	UntilTime           uint32
	Status              uint32
	cJobs               uint32
	AveragePPM          uint32
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
