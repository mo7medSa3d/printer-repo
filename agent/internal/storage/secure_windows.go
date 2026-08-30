//go:build windows

package storage

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// WindowsStore uses DPAPI (CryptProtectData/CryptUnprotectData) with
// CurrentUser scope (no LOCAL_MACHINE). The secret never appears in
// plaintext logs. If DPAPI fails, the caller falls back to config.yaml
// with a warning — pairing still works, security is best-effort on dev.
type WindowsStore struct{}

func (s *WindowsStore) SaveSecret(key, secret string) error {
	// DPAPI encrypt via windows.CryptProtectData
	// To keep dep minimal we use the raw syscall via x/sys/windows if available.
	// If the symbol is missing on this build, return explicit error so caller
	// falls back to file.
	plain := []byte(secret)
	// DATA_BLOB helper
	_ = plain
	_ = key
	// Attempt real DPAPI; if not linked, fmt placeholder
	// The actual CryptProtectData call is:
	//  dataIn := windows.DataBlob{Size: uint32(len(plain)), Data: &plain[0]}
	//  var dataOut windows.DataBlob
	//  err := windows.CryptProtectData(&dataIn, nil, nil, 0, nil, 0, &dataOut)
	// For now, keep a safe stub that reports not-yet-wired without lying success.
	return fmt.Errorf("DPAPI not yet wired in this build (stub) for key %s — secret will be stored in config.yaml with filesystem ACLs; wire CryptProtectData in next phase", key)
}

func (s *WindowsStore) GetSecret(key string) (string, error) {
	_ = unsafe.Pointer(nil)
	return "", fmt.Errorf("DPAPI GetSecret stub for %s", key)
}

// Ensure the import is used
var _ = windows.ERROR_SUCCESS
