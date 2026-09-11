package printer

import (
	"bytes"
	"testing"
)

func rasterWidthFromESCPOS(data []byte) int {
	marker := []byte{0x1d, 0x76, 0x30, 0x00}
	idx := bytes.Index(data, marker)
	if idx < 0 || idx+6 >= len(data) {
		return 0
	}
	lo, hi := data[idx+4], data[idx+5]
	return int(lo) | int(hi)<<8
}

func TestRasterMaxWidthFromCapabilities(t *testing.T) {
	cases := []struct {
		name string
		caps map[string]interface{}
		want int
	}{
		{"unknown", nil, SafeRasterMaxWidth},
		{"explicit 58mm", map[string]interface{}{"max_paper_width": 58}, 384},
		{"explicit 576 dots", map[string]interface{}{"max_paper_width": 576}, 576},
		{"legacy narrow set", map[string]interface{}{"paper_widths": []int{58, 80}}, 384},
		{"json numbers", map[string]interface{}{"paper_widths": []interface{}{80.0}}, 576},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RasterMaxWidthFromCapabilities(tc.caps); got != tc.want {
				t.Fatalf("got %d want %d", got, tc.want)
			}
		})
	}
}

func TestJPEGToESCPOSWithMaxWidthHonors58mmCapability(t *testing.T) {
	jpegData := createTestJPEG(576, 1)
	out, err := JPEGToESCPOSWithMaxWidth(jpegData, 256, 384)
	if err != nil {
		t.Fatalf("conversion failed: %v", err)
	}
	if got := rasterWidthFromESCPOS(out); got != 48 { // 384 dots => 48 bytes per row
		t.Fatalf("first raster row is %d bytes wide; want 48", got)
	}
}

func TestJPEGToESCPOSWithMaxWidthHonors80mmCapability(t *testing.T) {
	jpegData := createTestJPEG(600, 1)
	out, err := JPEGToESCPOSWithMaxWidth(jpegData, 256, 576)
	if err != nil {
		t.Fatalf("conversion failed: %v", err)
	}
	if got := rasterWidthFromESCPOS(out); got != 72 { // 576 dots => 72 bytes per row
		t.Fatalf("first raster row is %d bytes wide; want 72", got)
	}
}
