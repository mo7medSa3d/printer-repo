// Package payload implements the strict print-job payload contract shared
// between the Cloud Print Gateway and the Windows agent. See API.md /
// PRINTERS.md for the documented wire format.
//
//	{
//	  "type": "raw" | "escpos",
//	  "encoding": "base64",
//	  "data": "<base64-encoded bytes>"
//	}
//
// Any payload that does not match this exact shape is rejected before it
// ever reaches a printer backend.
package payload

import (
	"encoding/base64"
	"fmt"
)

type Type string

const (
	TypeRaw    Type = "raw"
	TypeESCPOS Type = "escpos"
)

const EncodingBase64 = "base64"

// MaxPayloadBytes bounds the decoded payload size to protect the agent
// from unbounded memory use on a malicious or malformed job.
const MaxPayloadBytes = 5 * 1024 * 1024 // 5MB

type Payload struct {
	Type Type
	Data []byte
}

// Parse validates and decodes the raw `payload` field of a job as received
// from the gateway (either via WebSocket push or HTTP poll, both of which
// decode JSON into map[string]interface{}). It never returns partially
// validated data: either the payload is fully valid and printable, or an
// error is returned and nothing should be sent to a printer.
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
	case TypeRaw, TypeESCPOS:
		// ok
	case "":
		return nil, fmt.Errorf("payload.type is required")
	default:
		return nil, fmt.Errorf("unsupported payload type %q (expected %q or %q)", typ, TypeRaw, TypeESCPOS)
	}

	encoding, _ := m["encoding"].(string)
	if encoding != EncodingBase64 {
		return nil, fmt.Errorf("unsupported payload encoding %q (only %q is supported)", encoding, EncodingBase64)
	}

	dataStr, _ := m["data"].(string)
	if dataStr == "" {
		return nil, fmt.Errorf("payload.data is required")
	}

	// Cheap pre-check before allocating the decode buffer: base64 expands
	// ~4/3, so this rejects grossly oversized payloads without decoding them.
	if len(dataStr) > (MaxPayloadBytes/3)*4+8 {
		return nil, fmt.Errorf("payload too large (exceeds %d byte limit)", MaxPayloadBytes)
	}

	decoded, err := base64.StdEncoding.DecodeString(dataStr)
	if err != nil {
		return nil, fmt.Errorf("payload.data is not valid base64: %w", err)
	}

	if len(decoded) == 0 {
		return nil, fmt.Errorf("decoded payload is empty")
	}
	if len(decoded) > MaxPayloadBytes {
		return nil, fmt.Errorf("payload exceeds %d byte limit (got %d)", MaxPayloadBytes, len(decoded))
	}

	return &Payload{Type: Type(typ), Data: decoded}, nil
}
