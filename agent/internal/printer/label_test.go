package printer

import (
	"context"
	"testing"
)

func TestDetectLabelProtocol(t *testing.T) {
	zpl := []byte("^XA^FO50,50^ADN,36,20^FDHello World^FS^XZ")
	if proto := DetectLabelProtocol(zpl); proto != ProtocolZPL {
		t.Fatalf("expected zpl, got %s", proto)
	}

	tspl := []byte("SIZE 75 mm, 50 mm\nGAP 3 mm, 0\nCLS\nTEXT 50,50,\"3\",0,1,1,\"Hello\"\nPRINT 1,1\n")
	if proto := DetectLabelProtocol(tspl); proto != ProtocolTSPL {
		t.Fatalf("expected tspl, got %s", proto)
	}

	raw := []byte("plain text barcode")
	if proto := DetectLabelProtocol(raw); proto != ProtocolRaw {
		t.Fatalf("expected raw, got %s", proto)
	}
}

func TestLabelPrinterExecution(t *testing.T) {
	mock := &mockTestPrinter{}
	lp := NewLabelPrinter(mock, ProtocolZPL, "Zebra-GK420d")

	if !lp.SupportsKind(KindZPL) {
		t.Fatal("label printer must support zpl")
	}
	if !lp.SupportsKind(KindLabel) {
		t.Fatal("label printer must support label")
	}
	if lp.SupportsKind(KindPDF) {
		t.Fatal("label printer should not support pdf")
	}

	ctx := context.Background()
	err := lp.PrintDocument(ctx, Document{Kind: KindZPL, Data: []byte("^XA^XZ")})
	if err != nil {
		t.Fatalf("PrintDocument failed: %v", err)
	}
	if len(mock.printed) == 0 {
		t.Fatal("expected mock to have received bytes")
	}

	// Test label generation
	err = lp.Test(ctx)
	if err != nil {
		t.Fatalf("Test label failed: %v", err)
	}
}

type mockTestPrinter struct {
	printed []byte
}

func (m *mockTestPrinter) Print(ctx context.Context, data []byte) error {
	m.printed = append(m.printed, data...)
	return nil
}

func (m *mockTestPrinter) Test(ctx context.Context) error {
	return nil
}

func (m *mockTestPrinter) Status() string {
	return "online"
}
