package printer

import (
	"bytes"
	"context"
	"fmt"
	"strings"
)

// LabelProtocol represents supported label description languages.
type LabelProtocol string

const (
	ProtocolZPL  LabelProtocol = "zpl"
	ProtocolTSPL LabelProtocol = "tspl"
	ProtocolRaw  LabelProtocol = "raw"
)

// DetectLabelProtocol inspects bytes to determine if the payload is ZPL or TSPL.
func DetectLabelProtocol(data []byte) LabelProtocol {
	trimmed := bytes.TrimSpace(data)
	if bytes.HasPrefix(trimmed, []byte("^XA")) || bytes.Contains(trimmed, []byte("^XA")) || bytes.Contains(trimmed, []byte("^FO")) {
		return ProtocolZPL
	}
	upper := strings.ToUpper(string(trimmed))
	if strings.Contains(upper, "SIZE ") && (strings.Contains(upper, "GAP ") || strings.Contains(upper, "CLS\n") || strings.Contains(upper, "PRINT ")) {
		return ProtocolTSPL
	}
	return ProtocolRaw
}

// GenerateZPLTestLabel produces a standard 4x6" or 3x2" Zebra test label.
func GenerateZPLTestLabel(printerName string) []byte {
	return []byte(fmt.Sprintf("^XA\n"+
		"^FO50,50^A0N,40,40^FDOdoo Print Gateway^FS\n"+
		"^FO50,105^A0N,28,28^FDLabel Hardware Test: %s^FS\n"+
		"^FO50,150^BY3,3,70^BCN,70,Y,N,N^FDTEST-123456^FS\n"+
		"^FO50,260^A0N,24,24^FDStatus: ONLINE (ZPL)^FS\n"+
		"^XZ\n", printerName))
}

// GenerateTSPLTestLabel produces a standard TSC test label.
func GenerateTSPLTestLabel(printerName string) []byte {
	return []byte(fmt.Sprintf("SIZE 75 mm, 50 mm\n"+
		"GAP 3 mm, 0\n"+
		"DIRECTION 1\n"+
		"CLS\n"+
		"TEXT 50,40,\"4\",0,1,1,\"Odoo Print Gateway\"\n"+
		"TEXT 50,90,\"2\",0,1,1,\"Label Hardware Test: %s\"\n"+
		"BARCODE 50,130,\"128\",60,1,0,2,2,\"TEST-123456\"\n"+
		"TEXT 50,210,\"2\",0,1,1,\"Status: ONLINE (TSPL)\"\n"+
		"PRINT 1,1\n", printerName))
}

// LabelPrinter wraps an underlying byte transport printer for label execution.
type LabelPrinter struct {
	Backend  Printer
	Protocol LabelProtocol
	Name     string
}

func NewLabelPrinter(backend Printer, protocol LabelProtocol, name string) *LabelPrinter {
	return &LabelPrinter{
		Backend:  backend,
		Protocol: protocol,
		Name:     name,
	}
}

func (lp *LabelPrinter) Print(ctx context.Context, data []byte) error {
	return lp.Backend.Print(ctx, data)
}

func (lp *LabelPrinter) SupportsKind(kind string) bool {
	switch NormalizeKind(kind) {
	case KindRaw, KindZPL, KindTSPL, KindLabel:
		return true
	default:
		return false
	}
}

func (lp *LabelPrinter) PrintDocument(ctx context.Context, doc Document) error {
	kind := NormalizeKind(doc.Kind)
	switch kind {
	case KindRaw, KindZPL, KindTSPL, KindLabel:
		return lp.Backend.Print(ctx, doc.Data)
	default:
		return CapabilityMismatchf("label printer %s cannot render %s payloads", lp.Name, kind)
	}
}

func (lp *LabelPrinter) Test(ctx context.Context) error {
	if lp.Protocol == ProtocolTSPL {
		return lp.Backend.Print(ctx, GenerateTSPLTestLabel(lp.Name))
	}
	return lp.Backend.Print(ctx, GenerateZPLTestLabel(lp.Name))
}

func (lp *LabelPrinter) Status() string {
	return lp.Backend.Status()
}
