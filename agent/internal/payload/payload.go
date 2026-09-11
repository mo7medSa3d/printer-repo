// Package payload implements the strict print-job payload contract shared
// between the Cloud Print Gateway and the Windows agent.
package payload

import (
	"bytes"
	"encoding/base64"
	"fmt"
)

type Type string

const (
	TypeRaw    Type = "raw"
	TypeESCPOS Type = "escpos"
	TypePDF    Type = "pdf"
	TypeImage  Type = "image"
)

const EncodingBase64 = "base64"
const MaxPayloadBytes = 5 * 1024 * 1024

type Peripherals struct {
	Drawer string
	Cutter string
	Buzzer string
}

type Payload struct {
	Type        Type
	Protocol    string
	Data        []byte
	Peripherals Peripherals
}

func Parse(raw interface{}) (*Payload, error) {
	if raw == nil {
		return nil, fmt.Errorf("payload is missing")
	}
	m, ok := raw.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("payload must be a JSON object")
	}

	typ, _ := m["type"].(string)
	switch Type(typ) {
	case TypeRaw, TypeESCPOS, TypePDF, TypeImage:
	default:
		if typ == "" {
			return nil, fmt.Errorf("payload.type is required")
		}
		return nil, fmt.Errorf("unsupported payload type %q (expected %q, %q, %q or %q)", typ, TypeRaw, TypeESCPOS, TypePDF, TypeImage)
	}

	protocol, _ := m["protocol"].(string)

	switch Type(typ) {
	case TypeRaw:
		if protocol == "" {
			return nil, fmt.Errorf("protocol is required for raw payloads")
		}
		switch protocol {
		case "raw", "escpos", "zpl", "tspl":
		default:
			return nil, fmt.Errorf("unsupported protocol %q for raw payload", protocol)
		}
	case TypeESCPOS:
		if protocol == "" {
			return nil, fmt.Errorf("protocol is required for escpos payloads")
		}
		if protocol != "escpos" {
			return nil, fmt.Errorf("protocol %q is incompatible with escpos payload", protocol)
		}
	case TypePDF, TypeImage:
		if protocol != "" {
			return nil, fmt.Errorf("protocol is not applicable for %s payloads", typ)
		}
	}

	encoding, _ := m["encoding"].(string)
	if encoding != EncodingBase64 {
		return nil, fmt.Errorf("unsupported payload encoding %q (only %q is supported)", encoding, EncodingBase64)
	}
	dataStr, _ := m["data"].(string)
	if dataStr == "" {
		return nil, fmt.Errorf("payload.data is required")
	}
	if len(dataStr) > (MaxPayloadBytes/3)*4+8 {
		return nil, fmt.Errorf("payload too large (exceeds %d byte limit)", MaxPayloadBytes)
	}
	decoded, err := base64.StdEncoding.DecodeString(dataStr)
	if err != nil {
		return nil, fmt.Errorf("payload.data is not valid base64: %w", err)
	}
	if len(decoded) == 0 || len(decoded) > MaxPayloadBytes {
		return nil, fmt.Errorf("payload exceeds %d byte limit", MaxPayloadBytes)
	}

	// Signature search window (64 bytes) mirrors pdf.go's
	// pdfHeaderSearchWindow: producers that emit a UTF-8 BOM or stray
	// leading whitespace must pass intake exactly when execution accepts
	// them. Anything beyond the window is irrelevant to format detection.
	head := decoded
	if len(head) > 64 {
		head = head[:64]
	}
	looksLikePDF := bytes.Contains(head, []byte("%PDF-"))
	looksLikeJPEG := len(decoded) >= 3 && decoded[0] == 0xff && decoded[1] == 0xd8 && decoded[2] == 0xff
	if Type(typ) == TypePDF && !looksLikePDF {
		return nil, fmt.Errorf("PDF payload must start with the %%PDF- signature")
	}
	if Type(typ) == TypeImage && !looksLikeJPEG {
		return nil, fmt.Errorf("image payload must be a JPEG")
	}
	if (Type(typ) == TypeRaw || Type(typ) == TypeESCPOS) && looksLikePDF {
		return nil, fmt.Errorf("PDF bytes cannot be labeled as raw/escpos")
	}

	var periph Peripherals
	if periphMap, ok := m["peripherals"].(map[string]interface{}); ok {
		if d, ok := periphMap["drawer"].(string); ok {
			switch d {
			case "pin2", "pin5", "none":
				periph.Drawer = d
			default:
				return nil, fmt.Errorf("invalid drawer mode %q", d)
			}
		}
		if c, ok := periphMap["cutter"].(string); ok {
			switch c {
			case "partial", "full", "none":
				periph.Cutter = c
			default:
				return nil, fmt.Errorf("invalid cutter mode %q", c)
			}
		}
		if b, ok := periphMap["buzzer"].(string); ok {
			switch b {
			case "epson_pulse", "star_bel", "none":
				periph.Buzzer = b
			default:
				return nil, fmt.Errorf("invalid buzzer mode %q", b)
			}
		}
	}

	// "none" is an INACTIVE setting, not an action: it must never count as
	// a configured peripheral (serializing inactive peripherals as active
	// semantic values would make e.g. {drawer:"none"} a zpl payload killer).
	active := func(v string) bool { return v != "" && v != "none" }
	hasPeripherals := active(periph.Drawer) || active(periph.Cutter) || active(periph.Buzzer)
	if hasPeripherals && protocol != "escpos" {
		return nil, fmt.Errorf("peripherals are only supported for escpos protocol")
	}
	if !hasPeripherals {
		periph = Peripherals{}
	}

	return &Payload{
		Type:        Type(typ),
		Protocol:    protocol,
		Data:        decoded,
		Peripherals: periph,
	}, nil
}
