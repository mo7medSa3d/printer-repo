//go:build windows

package printer

import (
	"context"
	"fmt"
	"log"
	"syscall"
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
)

// DOC_INFO_1W for StartDocPrinterW
type docInfo1 struct {
	pDocName    *uint16
	pOutputFile *uint16
	pDatatype   *uint16
}

// SpoolerPrinter implements Windows Print Spooler printing via winspool.drv.
// It opens the named printer, starts a RAW document, writes bytes, and closes.
type SpoolerPrinter struct {
	Name        string
	SpoolerName string
}

func NewSpooler(spoolerName, displayName string) *SpoolerPrinter {
	name := spoolerName
	if displayName != "" {
		name = displayName
	}
	return &SpoolerPrinter{Name: name, SpoolerName: spoolerName}
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

	printerNamePtr, err := syscall.UTF16PtrFromString(p.SpoolerName)
	if err != nil {
		return fmt.Errorf("invalid spooler name %q: %w", p.SpoolerName, err)
	}

	var hPrinter syscall.Handle
	ret, _, err := procOpenPrinterW.Call(uintptr(unsafe.Pointer(printerNamePtr)), uintptr(unsafe.Pointer(&hPrinter)), 0)
	if ret == 0 {
		return fmt.Errorf("OpenPrinterW(%q) failed: %w", p.SpoolerName, err)
	}
	defer func() {
		procClosePrinter.Call(uintptr(hPrinter))
	}()

	docName, _ := syscall.UTF16PtrFromString("Odoo Print Job")
	dataType, _ := syscall.UTF16PtrFromString("RAW")
	di := docInfo1{pDocName: docName, pOutputFile: nil, pDatatype: dataType}

	jobID, _, err := procStartDocPrinterW.Call(uintptr(hPrinter), 1, uintptr(unsafe.Pointer(&di)))
	if jobID == 0 {
		return fmt.Errorf("StartDocPrinterW(%q) failed: %w", p.SpoolerName, err)
	}
	defer func() {
		// EndDocPrinter even if Write fails; log errors.
		if _, _, e := procEndDocPrinter.Call(uintptr(hPrinter)); e != nil && e != syscall.Errno(0) {
			log.Printf("EndDocPrinter warning for %s: %v", p.SpoolerName, e)
		}
	}()

	ret, _, err = procStartPagePrinter.Call(uintptr(hPrinter))
	if ret == 0 {
		return fmt.Errorf("StartPagePrinter(%q) failed: %w", p.SpoolerName, err)
	}
	defer func() {
		procEndPagePrinter.Call(uintptr(hPrinter))
	}()

	// Write loop with context cancellation.
	written := 0
	for written < len(data) {
		select {
		case <-ctx.Done():
			return fmt.Errorf("print cancelled after %d/%d bytes: %w", written, len(data), ctx.Err())
		default:
		}
		var bytesWritten uint32
		chunk := data[written:]
		ret, _, err = procWritePrinter.Call(uintptr(hPrinter), uintptr(unsafe.Pointer(&chunk[0])), uintptr(len(chunk)), uintptr(unsafe.Pointer(&bytesWritten)))
		if ret == 0 {
			return fmt.Errorf("WritePrinter(%q) failed after %d/%d bytes: %w", p.SpoolerName, written, len(data), err)
		}
		if bytesWritten == 0 {
			return fmt.Errorf("WritePrinter(%q) wrote 0 bytes", p.SpoolerName)
		}
		written += int(bytesWritten)
		if int(bytesWritten) < len(chunk) {
			// Short write should not happen, but continue loop.
			log.Printf("Spooler %s short write %d/%d", p.SpoolerName, bytesWritten, len(chunk))
		}
	}
	log.Printf("Spooler printed %d bytes to %s (job %d)", written, p.SpoolerName, jobID)
	return nil
}

func (p *SpoolerPrinter) Test(ctx context.Context) error {
	data := []byte("\x1b\x40Spooler Test Print from Odoo Agent\nPrinter: " + p.SpoolerName + "\n\n\x1d\x56\x01")
	return p.Print(ctx, data)
}

func (p *SpoolerPrinter) Status() string {
	printerNamePtr, err := syscall.UTF16PtrFromString(p.SpoolerName)
	if err != nil {
		return "error"
	}
	var hPrinter syscall.Handle
	ret, _, _ := procOpenPrinterW.Call(uintptr(unsafe.Pointer(printerNamePtr)), uintptr(unsafe.Pointer(&hPrinter)), 0)
	if ret == 0 {
		return "offline"
	}
	procClosePrinter.Call(uintptr(hPrinter))
	return "online"
}

// printerInfo2 mirrors Windows PRINTER_INFO_2W (winspool.h).
// Field order and types must exactly match the Win32 struct for correct
// parsing via EnumPrintersW level 2. Pointers are *uint16 (LPWSTR),
// DEVMODE and SECURITY_DESCRIPTOR are opaque pointers, DWORDs are uint32.
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

// utf16PtrToString safely converts a *uint16 (possibly nil) to Go string
// without truncation using the standard windows helper.
func utf16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	return windows.UTF16PtrToString(p)
}

// EnumSpoolerPrinters enumerates Windows spooler printers via EnumPrintersW
// with correct PRINTER_INFO_2W parsing (no hardcoded structSize hack).
func EnumSpoolerPrinters() ([]DeviceInfo, error) {
	const (
		PRINTER_ENUM_LOCAL       = 0x00000002
		PRINTER_ENUM_CONNECTIONS = 0x00000004
		level                    = 2 // PRINTER_INFO_2
	)
	flags := uintptr(PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS)

	log.Printf("[discovery] starting Windows spooler discovery (EnumPrintersW level %d, flags 0x%x)", level, flags)

	var needed, returned uint32
	// First call to get required buffer size. Expected to fail with ERROR_INSUFFICIENT_BUFFER (122) and set needed.
	procEnumPrintersW.Call(flags, 0, uintptr(level), 0, 0, uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)))
	if needed == 0 {
		log.Printf("[discovery] spooler discovery: no printers (needed=0, returned=%d)", returned)
		return nil, nil
	}
	// Allocate exact buffer as requested. Add small guard for race where printers added between calls.
	buf := make([]byte, needed)
	ret, _, lastErr := procEnumPrintersW.Call(flags, 0, uintptr(level), uintptr(unsafe.Pointer(&buf[0])), uintptr(needed), uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)))
	if ret == 0 {
		// If buffer still insufficient, lastErr is ERROR_INSUFFICIENT_BUFFER; retry with new needed
		if needed > uint32(len(buf)) {
			log.Printf("[discovery] spooler buffer still insufficient (needed %d > %d), retrying", needed, len(buf))
			buf = make([]byte, needed)
			ret, _, lastErr = procEnumPrintersW.Call(flags, 0, uintptr(level), uintptr(unsafe.Pointer(&buf[0])), uintptr(needed), uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)))
		}
		if ret == 0 {
			return nil, fmt.Errorf("EnumPrintersW failed after retry: %v (needed=%d returned=%d)", lastErr, needed, returned)
		}
	}

	if returned == 0 {
		log.Printf("[discovery] spooler discovery: EnumPrintersW returned 0 printers (needed=%d)", needed)
		return nil, nil
	}

	// Correct struct size via unsafe.Sizeof (handles 32 vs 64 bit)
	structSize := unsafe.Sizeof(printerInfo2{})
	expectedBytes := uintptr(returned) * structSize
	if expectedBytes > uintptr(len(buf)) {
		// Defensive: returned count claims more bytes than buffer holds → truncate to avoid OOB
		log.Printf("[discovery] warning: returned %d * structSize %d = %d > buf %d, truncating", returned, structSize, expectedBytes, len(buf))
		maxCount := uint32(len(buf)) / uint32(structSize)
		returned = maxCount
		if returned == 0 {
			return nil, fmt.Errorf("EnumPrintersW returned struct count exceeds buffer")
		}
	}

	infos := make([]DeviceInfo, 0, returned)
	base := unsafe.Pointer(&buf[0])
	for i := uint32(0); i < returned; i++ {
		pi := (*printerInfo2)(unsafe.Add(base, uintptr(i)*structSize))

		// Extract mandatory printer name; skip entries with null/empty
		name := utf16PtrToString(pi.pPrinterName)
		if name == "" {
			log.Printf("[discovery] skipping spooler entry %d: empty pPrinterName (pPortName=%q pDriverName=%q)", i, utf16PtrToString(pi.pPortName), utf16PtrToString(pi.pDriverName))
			continue
		}
		portName := utf16PtrToString(pi.pPortName)
		driverName := utf16PtrToString(pi.pDriverName)
		shareName := utf16PtrToString(pi.pShareName)
		comment := utf16PtrToString(pi.pComment)
		location := utf16PtrToString(pi.pLocation)
		// serverName := utf16PtrToString(pi.pServerName) // usually nil for local

		// Map Windows status/attributes to our status (do not hardcode online)
		status := mapWindowsStatus(pi.Status, pi.Attributes)
		enabled := pi.Attributes&0x00000400 == 0 // WORK_OFFLINE bit not set

		isVirtual := isVirtualSpooler(portName, driverName, name)
		printerType, connType := classifySpoolerPrinter(portName, driverName, name)
		if isVirtual {
			printerType = "virtual"
		}

		// Infer network address/port if portName is IP-like
		var netAddr string
		var netPort int
		if portName != "" {
			cleanPort := portName
			if spoolerHasPrefix(cleanPort, "IP_") {
				cleanPort = cleanPort[3:]
			}
			if idx := spoolerIndexComma(cleanPort); idx >= 0 {
				cleanPort = cleanPort[:idx]
			}
			if host, portStr, err := spoolerSplitPort(cleanPort); err == nil {
				netAddr = host
				if p, err := spoolerStrconvAtoi(portStr); err == nil {
					netPort = p
				}
			} else {
				if spoolerIsIPLike(cleanPort) {
					netAddr = cleanPort
					if connType == "network" {
						netPort = 9100
					}
				}
			}
		}

		id := StableIDFromSpooler(name)

		// Build capabilities stub (empty unknown, to be enriched later via DevMode if available)
		caps := map[string]interface{}{}
		if location != "" {
			caps["location"] = location
		}
		if comment != "" {
			caps["comment"] = comment
		}
		if portName != "" {
			caps["port_name"] = portName
		}
		if driverName != "" {
			caps["driver_name"] = driverName
		}
		if shareName != "" {
			caps["share_name"] = shareName
		}
		if isVirtual {
			caps["virtual"] = true
			caps["is_virtual"] = true
		}
		// Keep capabilities empty if no reliable info; gateway treats empty as unknown

		info := DeviceInfo{
			ID:             id,
			Name:           name,
			DisplayName:    name,
			PrinterType:    printerType,
			ConnectionType: connType,
			Protocol:       "spooler",
			Endpoint:       name,
			SpoolerName:    name,
			NetworkAddress: netAddr,
			Port:           netPort,
			Status:         status,
			Enabled:        enabled,
			IsVirtual:      isVirtual,
			Capabilities:   caps,
			Type:           connType, // legacy
		}
		// Store port/driver as USB fields? No, keep spooler-specific in capabilities + separate fields
		// NetworkAddress/Port already set for network spooler ports

		log.Printf("[discovery] found spooler printer: %q port=%q driver=%q status=%s enabled=%v type=%s conn=%s", name, portName, driverName, status, enabled, printerType, connType)
		infos = append(infos, info)
	}

	log.Printf("[discovery] spooler discovery completed: %d printers (returned=%d needed=%d)", len(infos), returned, needed)
	return infos, nil
}
