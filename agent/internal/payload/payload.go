// Package payload implements the strict print-job payload contract shared
// between the Cloud Print Gateway and the Windows agent.
package payload

import (
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

type Payload struct {
	Type Type
	Data []byte
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

	looksLikePDF := len(decoded) >= 5 && string(decoded[:5]) == "%PDF-"
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
	return &Payload{Type: Type(typ), Data: decoded}, nil
}