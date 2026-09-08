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

type docInfo1 struct {
	pDocName    *uint16
	pOutputFile *uint16
	pDatatype   *uint16
}

type SpoolerPrinter struct {
	Name       string
	SpoolerName string
	PDFPrint   PDFPrintFunc
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
	ret, _, err := procOpenPrinterW.Call(
		uintptr(unsafe.Pointer(printerNamePtr)),
		uintptr(unsafe.Pointer(&hPrinter)),
		0,
	)
	if ret == 0 {
		return fmt.Errorf("OpenPrinterW(%q) failed: %w", p.SpoolerName, err)
	}
	defer procClosePrinter.Call(uintptr(hPrinter))

	docName, err := syscall.UTF16PtrFromString("Odoo Print Job")
	if err != nil {
		return fmt.Errorf("invalid document name: %w", err)
	}
	dataType, err := syscall.UTF16PtrFromString("RAW")
	if err != nil {
		return fmt.Errorf("invalid datatype: %w", err)
	}
	di := docInfo1{pDocName: docName, pDatatype: dataType}
	jobID, _, err := procStartDocPrinterW.Call(
		uintptr(hPrinter),
		1,
		uintptr(unsafe.Pointer(&di)),
	)
	if jobID == 0 {
		return fmt.Errorf("StartDocPrinterW(%q) failed: %w", p.SpoolerName, err)
	}
	defer func() {
		if _, _, e := procEndDocPrinter.Call(uintptr(hPrinter)); e != nil && e != syscall.Errno(0) {
			log.Printf("EndDocPrinter warning for %s: %v", p.SpoolerName, e)
		}
	}()

	ret, _, err = procStartPagePrinter.Call(uintptr(hPrinter))
	if ret == 0 {
		return fmt.Errorf("StartPagePrinter(%q) failed: %w", p.SpoolerName, err)
	}
	defer procEndPagePrinter.Call(uintptr(hPrinter))

	type writeResult struct {
		ret          uintptr
		bytesWritten uint32
		err          error
	}

	written := 0
	for written < len(data) {
		chunk := data[written:]
		resChan := make(chan writeResult, 1)

		go func(buf []byte) {
			var bw uint32
			r, _, e := procWritePrinter.Call(
				uintptr(hPrinter),
				uintptr(unsafe.Pointer(&buf[0])),
				uintptr(len(buf)),
				uintptr(unsafe.Pointer(&bw)),
			)
			resChan <- writeResult{ret: r, bytesWritten: bw, err: e}
		}(chunk)

		select {
		case <-ctx.Done():
			if written > 0 {
				return fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: print cancelled after %d/%d bytes: %w", written, len(data), ctx.Err())
			}
			return fmt.Errorf("print cancelled after %d/%d bytes: %w", written, len(data), ctx.Err())
		case res := <-resChan:
			if res.ret == 0 {
				if written > 0 {
					return fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: WritePrinter(%q) failed after %d/%d bytes: %w", p.SpoolerName, written, len(data), res.err)
				}
				return fmt.Errorf("WritePrinter(%q) failed after %d/%d bytes: %w", p.SpoolerName, written, len(data), res.err)
			}
			if res.bytesWritten == 0 {
				if written > 0 {
					return fmt.Errorf("UNKNOWN_PARTIAL_DELIVERY: WritePrinter(%q) wrote 0 bytes after %d/%d bytes", p.SpoolerName, written, len(data))
				}
				return fmt.Errorf("WritePrinter(%q) wrote 0 bytes", p.SpoolerName)
			}
			written += int(res.bytesWritten)
		}
	}

	log.Printf("Spooler printed %d bytes to %s (job %d)", written, p.SpoolerName, jobID)
	return nil
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
	printerNamePtr, err := syscall.UTF16PtrFromString(p.SpoolerName)
	if err != nil {
		return "error"
	}
	var hPrinter syscall.Handle
	ret, _, _ := procOpenPrinterW.Call(
		uintptr(unsafe.Pointer(printerNamePtr)),
		uintptr(unsafe.Pointer(&hPrinter)),
		0,
	)
	if ret == 0 {
		return "offline"
	}
	procClosePrinter.Call(uintptr(hPrinter))
	return "online"
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
