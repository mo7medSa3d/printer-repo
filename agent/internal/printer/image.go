package printer

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/jpeg"
	"math"
)

const (
	maxRasterWidth             = 576
	DefaultRasterSliceHeight   = 256
	LowBufferRasterSliceHeight = 128
)

// JPEGToESCPOS converts an Odoo POS raster (JPEG) into an ESC/POS raster image.
// Breaking large thermal prints into discrete vertical bands (default 256px) prevents
// printer buffer overflows and ensures 100% Arabic text and QR code compatibility on budget printers.
func JPEGToESCPOS(data []byte) ([]byte, error) {
	return JPEGToESCPOSWithBanding(data, DefaultRasterSliceHeight)
}

// JPEGToESCPOSWithBanding slices the raster into chunks of at most sliceHeight pixels.
// Note: Hardcoded cuts have been removed from this function so cutting is governed solely
// by peripheral profile configurations in WrapPeripheralCommands.
func JPEGToESCPOSWithBanding(data []byte, sliceHeight int) ([]byte, error) {
	if sliceHeight <= 0 {
		sliceHeight = DefaultRasterSliceHeight
	}
	cfg, err := decodeJPEGConfig(data)
	if err != nil {
		return nil, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, fmt.Errorf("invalid JPEG dimensions %dx%d", cfg.Width, cfg.Height)
	}

	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode JPEG: %w", err)
	}

	// Dynamic target width: 384px for 58mm paper, 576px for 80mm paper
	targetWidth := maxRasterWidth
	if img.Bounds().Dx() <= 384 {
		targetWidth = 384
	}
	if img.Bounds().Dx() > targetWidth {
		img = resizeNearest(img, targetWidth)
	}

	w := img.Bounds().Dx()
	h := img.Bounds().Dy()
	rowBytes := (w + 7) / 8

	// Pre-convert or extract direct raster buffer for performance
	rgbaImg, isRGBA := img.(*image.RGBA)

	out := bytes.NewBuffer(make([]byte, 0, rowBytes*h+128))
	out.Write([]byte{0x1b, 0x40}) // ESC @ (initialize)

	// Emit vertical bands
	for yStart := 0; yStart < h; yStart += sliceHeight {
		bandHeight := sliceHeight
		if yStart+bandHeight > h {
			bandHeight = h - yStart
		}
		bandRaster := make([]byte, rowBytes*bandHeight)

		for by := 0; by < bandHeight; by++ {
			actualY := yStart + by
			bandOffset := by * rowBytes

			if isRGBA {
				pixRowOffset := (actualY - rgbaImg.Bounds().Min.Y) * rgbaImg.Stride
				for x := 0; x < w; x++ {
					pixIdx := pixRowOffset + (x+rgbaImg.Bounds().Min.X)*4
					r := uint32(rgbaImg.Pix[pixIdx])
					g := uint32(rgbaImg.Pix[pixIdx+1])
					b := uint32(rgbaImg.Pix[pixIdx+2])
					// Fast integer ITU-R BT.601 luma
					luma := uint8((299*r + 587*g + 114*b) / 1000)
					if luma < 180 {
						bandRaster[bandOffset+x/8] |= 0x80 >> uint(x%8)
					}
				}
			} else {
				for x := 0; x < w; x++ {
					g := grayscale(img.At(img.Bounds().Min.X+x, img.Bounds().Min.Y+actualY))
					if g < 180 { // 1-bit high-contrast threshold for crisp Arabic text & QR codes
						bandRaster[bandOffset+x/8] |= 0x80 >> uint(x%8)
					}
				}
			}
		}

		// GS v 0 (raster bit image)
		out.Write([]byte{0x1d, 0x76, 0x30, 0x00})
		out.WriteByte(byte(rowBytes))
		out.WriteByte(byte(rowBytes >> 8))
		out.WriteByte(byte(bandHeight))
		out.WriteByte(byte(bandHeight >> 8))
		out.Write(bandRaster)
	}

	return out.Bytes(), nil
}

func decodeJPEGConfig(data []byte) (image.Config, error) {
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return image.Config{}, fmt.Errorf("invalid JPEG image: %w", err)
	}
	return cfg, nil
}

func resizeNearest(src image.Image, width int) image.Image {
	if width <= 0 || src.Bounds().Dx() <= width {
		return src
	}
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	h := int(math.Round(float64(sh) * float64(width) / float64(sw)))
	dst := image.NewRGBA(image.Rect(0, 0, width, h))
	for y := 0; y < h; y++ {
		sy := src.Bounds().Min.Y + y*sh/h
		for x := 0; x < width; x++ {
			sx := src.Bounds().Min.X + x*sw/width
			dst.Set(x, y, src.At(sx, sy))
		}
	}
	return dst
}

func grayscale(c color.Color) uint8 {
	r, g, b, _ := c.RGBA()
	// Integer approximation of ITU-R BT.601 luma.
	return uint8((299*r + 587*g + 114*b) / (1000 * 257))
}

// JPEGToPDF wraps the already-rendered JPEG as a single-page PDF. It is used
// for Windows print queues because the spooler implementation already has a
// PDF-aware path, while retaining the exact rasterized POS/Kitchen content.
func JPEGToPDF(data []byte) ([]byte, error) {
	cfg, err := decodeJPEGConfig(data)
	if err != nil {
		return nil, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, fmt.Errorf("invalid JPEG dimensions %dx%d", cfg.Width, cfg.Height)
	}

	w, h := cfg.Width, cfg.Height

	// Determine color space based on JPEG color model
	colorSpace := "/DeviceRGB"
	if cfg.ColorModel == color.GrayModel {
		colorSpace = "/DeviceGray"
	}

	// Render the raster at 96 DPI, the same pixel assumption used by the web
	// renderer, while preserving its aspect ratio.
	pageW := float64(w) * 72.0 / 96.0
	pageH := float64(h) * 72.0 / 96.0

	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")
	offsets := make([]int, 6)
	writeObj := func(n int, body []byte) {
		offsets[n] = b.Len()
		fmt.Fprintf(&b, "%d 0 obj\n", n)
		b.Write(body)
		b.WriteString("\nendobj\n")
	}

	writeObj(1, []byte("<< /Type /Catalog /Pages 2 0 R >>"))
	writeObj(2, []byte("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"))
	pageBody := fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>", pageW, pageH)
	writeObj(3, []byte(pageBody))

	imageHeader := fmt.Sprintf("<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace %s /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n", w, h, colorSpace, len(data))
	offsets[4] = b.Len()
	fmt.Fprintf(&b, "4 0 obj\n%s", imageHeader)
	b.Write(data)
	b.WriteString("\nendstream\nendobj\n")

	content := fmt.Sprintf("q\n%.2f 0 0 %.2f 0 0 cm\n/Im0 Do\nQ\n", pageW, pageH)
	contentBody := fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", len(content), content)
	writeObj(5, []byte(contentBody))

	xref := b.Len()
	b.WriteString("xref\r\n0 6\r\n0000000000 65535 f\r\n")
	for i := 1; i <= 5; i++ {
		fmt.Fprintf(&b, "%010d 00000 n\r\n", offsets[i])
	}
	fmt.Fprintf(&b, "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", xref)
	return b.Bytes(), nil
}
