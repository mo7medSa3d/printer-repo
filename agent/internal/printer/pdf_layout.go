package printer

import "fmt"

// Page-fit math for embedded PDF printing (platform independent).
//
// A rendered PDF page is blitted onto the printer's printable area
// preserving aspect ratio: it is scaled to FIT (never cropped), centered,
// and never invents paper dimensions — the source is always the PDF page's
// own MediaBox via internal/pdfium, the target always the printer's
// reported printable area.

// fitPage scales an imgW×imgH image into an areaW×areaH box preserving
// aspect ratio, returning destination size and top-left offset (all device
// pixels). All inputs must be positive.
func fitPage(imgW, imgH, areaW, areaH int) (dw, dh, dx, dy int, err error) {
	if imgW <= 0 || imgH <= 0 || areaW <= 0 || areaH <= 0 {
		return 0, 0, 0, 0, fmt.Errorf("cannot fit %dx%d into %dx%d", imgW, imgH, areaW, areaH)
	}
	scaleW := float64(areaW) / float64(imgW)
	scaleH := float64(areaH) / float64(imgH)
	scale := scaleW
	if scaleH < scaleW {
		scale = scaleH
	}
	dw = int(float64(imgW)*scale + 0.5)
	dh = int(float64(imgH)*scale + 0.5)
	if dw < 1 {
		dw = 1
	}
	if dh < 1 {
		dh = 1
	}
	dx = (areaW - dw) / 2
	dy = (areaH - dh) / 2
	return dw, dh, dx, dy, nil
}

// pdfRenderSteps are the DPI rungs tried from high to low quality.
var pdfRenderSteps = []int{600, 450, 300, 225, 150, 96, 72}

// selectRenderDPI picks the highest DPI at or below printerDPI whose pixel
// count fits maxPixels (see internal/pdfium MaxRenderPixels). It never
// returns below 72 and never above the printer's own resolution: rendering
// past what the hardware resolves only burns RAM.
func selectRenderDPI(pageWpt, pageHpt float64, printerDPI, maxPixels int) (int, error) {
	if pageWpt <= 0 || pageHpt <= 0 {
		return 0, fmt.Errorf("invalid page size %.2fx%.2f pt", pageWpt, pageHpt)
	}
	if printerDPI <= 0 {
		printerDPI = 300
	}
	for _, dpi := range pdfRenderSteps {
		if dpi > printerDPI {
			continue
		}
		w := int(pageWpt*float64(dpi)/72.0 + 0.5)
		h := int(pageHpt*float64(dpi)/72.0 + 0.5)
		if w > 0 && h > 0 && int64(w)*int64(h) <= int64(maxPixels) {
			return dpi, nil
		}
	}
	return 0, fmt.Errorf("page %.2fx%.2f pt cannot fit %d pixel budget even at 72 DPI", pageWpt, pageHpt, maxPixels)
}
