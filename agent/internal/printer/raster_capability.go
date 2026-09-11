package printer

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"
)

// RasterMaxWidthFromCapabilities resolves the execution-safe raster width.
// max_paper_width is expressed in dots/pixels; paper_widths is accepted as a
// legacy capability in millimetres (58/80). Unknown or malformed values use
// SafeRasterMaxWidth so a narrow printer is never overrun by inference.
func RasterMaxWidthFromCapabilities(caps map[string]interface{}) int {
	if caps == nil {
		return SafeRasterMaxWidth
	}
	if v, ok := capabilityInt(caps["max_paper_width"]); ok && v > 0 {
		if v <= 128 { // backwards-compatible millimetre representation
			return paperMillimetresToDots(v)
		}
		return v
	}
	if widths, ok := capabilityInts(caps["paper_widths"]); ok && len(widths) > 0 {
		// A printer may support several roll widths. Without a per-job roll
		// selection contract, choose the narrowest advertised width. This is
		// safe across the complete supported set; operators can set
		// max_paper_width when a single wider width is guaranteed.
		minDots := 0
		for _, mm := range widths {
			dots := paperMillimetresToDots(mm)
			if dots <= 0 {
				continue
			}
			if minDots == 0 || dots < minDots {
				minDots = dots
			}
		}
		if minDots > 0 {
			return minDots
		}
	}
	return SafeRasterMaxWidth
}

func paperMillimetresToDots(mm int) int {
	switch {
	case mm <= 58:
		return 384
	case mm <= 80:
		return 576
	default:
		// Scale conservatively from the standard 80mm 576-dot reference.
		return int(float64(mm) * 576.0 / 80.0)
	}
}

func capabilityInt(v interface{}) (int, bool) {
	switch x := v.(type) {
	case int:
		return x, true
	case int8:
		return int(x), true
	case int16:
		return int(x), true
	case int32:
		return int(x), true
	case int64:
		return int(x), true
	case uint:
		return int(x), true
	case uint8:
		return int(x), true
	case uint16:
		return int(x), true
	case uint32:
		return int(x), true
	case uint64:
		if uint64(int(x)) != x {
			return 0, false
		}
		return int(x), true
	case float64:
		if x != float64(int(x)) {
			return 0, false
		}
		return int(x), true
	case float32:
		y := float64(x)
		if y != float64(int(y)) {
			return 0, false
		}
		return int(x), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		if err != nil {
			return 0, false
		}
		return n, true
	case fmt.Stringer:
		n, err := strconv.Atoi(strings.TrimSpace(x.String()))
		if err != nil {
			return 0, false
		}
		return n, true
	}
	return 0, false
}

func capabilityInts(v interface{}) ([]int, bool) {
	switch x := v.(type) {
	case []int:
		return append([]int(nil), x...), true
	case []interface{}:
		out := make([]int, 0, len(x))
		for _, item := range x {
			if n, ok := capabilityInt(item); ok {
				out = append(out, n)
			}
		}
		return out, len(out) == len(x)
	}
	rv := reflect.ValueOf(v)
	if rv.IsValid() && rv.Kind() == reflect.Slice {
		out := make([]int, 0, rv.Len())
		for i := 0; i < rv.Len(); i++ {
			n, ok := capabilityInt(rv.Index(i).Interface())
			if !ok {
				return nil, false
			}
			out = append(out, n)
		}
		return out, true
	}
	return nil, false
}
