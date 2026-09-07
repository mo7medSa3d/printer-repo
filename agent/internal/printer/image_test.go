package printer

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

func createTestJPEG(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if (x+y)%2 == 0 {
				img.Set(x, y, color.Black)
			} else {
				img.Set(x, y, color.White)
			}
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90})
	return buf.Bytes()
}

func TestAdaptiveRasterBanding(t *testing.T) {
	// A 600px tall receipt image should be split into 3 bands when sliceHeight is 256
	jpegData := createTestJPEG(576, 600)

	escpos, err := JPEGToESCPOSWithBanding(jpegData, 256)
	if err != nil {
		t.Fatalf("JPEGToESCPOSWithBanding failed: %v", err)
	}

	// Count occurrences of GS v 0 (\x1d\x76\x30\x00)
	gsV0 := []byte{0x1d, 0x76, 0x30, 0x00}
	count := bytes.Count(escpos, gsV0)
	if count != 3 {
		t.Fatalf("expected 3 raster bands for 600px image with sliceHeight=256, got %d", count)
	}

	// Test fallback for low-buffer printers (128px)
	escposLowBuffer, err := JPEGToESCPOSWithBanding(jpegData, 128)
	if err != nil {
		t.Fatalf("JPEGToESCPOSWithBanding (128px) failed: %v", err)
	}
	countLow := bytes.Count(escposLowBuffer, gsV0)
	if countLow != 5 { // 600 / 128 = 4 with 88 remainder => 5 bands
		t.Fatalf("expected 5 raster bands for 600px image with sliceHeight=128, got %d", countLow)
	}
}
