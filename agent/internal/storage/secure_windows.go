//go:build windows

package storage

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

var (
	modadvapi32            = syscall.NewLazyDLL("advapi32.dll")
	procCryptProtectData   = modadvapi32.NewProc("CryptProtectData")
	procCryptUnprotectData = modadvapi32.NewProc("CryptUnprotectData")
	procLocalFree          = modadvapi32.NewProc("LocalFree")
)

const (
	// CRYPTPROTECT_UI_FORBIDDEN: never show a UI prompt from a service.
	cryptProtectUIForbidden = 0x00000001
	// CRYPTPROTECT_LOCAL_MACHINE: the desktop app (user context) and the
	// agent (LocalSystem service) must both be able to read the same file.
	cryptProtectLocalMachine = 0x00000004
)

type dataBlob struct {
	cbData uint32
	pbData *byte
}

// platformEncrypt seals data with DPAPI in the LOCAL_MACHINE scope so the
// secret survives per-user profile loss and is readable by the service.
func platformEncrypt(data []byte) ([]byte, error) {
	return dpapi(procCryptProtectData, data, cryptProtectUIForbidden|cryptProtectLocalMachine)
}

// platformDecrypt opens data previously sealed with platformEncrypt.
// CryptUnprotectData picks the correct scope from the blob header itself;
// only the UI flag applies.
func platformDecrypt(data []byte) ([]byte, error) {
	return dpapi(procCryptUnprotectData, data, cryptProtectUIForbidden)
}

func dpapi(proc *syscall.LazyProc, data []byte, flags uintptr) ([]byte, error) {
	var inBlob dataBlob
	if len(data) > 0 {
		inBlob = dataBlob{cbData: uint32(len(data)), pbData: &data[0]}
	}
	var outBlob dataBlob
	r, _, callErr := proc.Call(
		uintptr(unsafe.Pointer(&inBlob)), // pDataIn
		0,                               // pDescription
		0,                               // pOptionalEntropy
		0,                               // pvReserved
		0,                               // pPromptStruct
		flags,                           // dwFlags
		uintptr(unsafe.Pointer(&outBlob)), // pDataOut
	)
	if r == 0 {
		// LazyProc.Call reports the OS error as an error interface value;
		// it is non-nil only when the API set the last error.
		if callErr != nil {
			return nil, fmt.Errorf("DPAPI call failed: %w", callErr)
		}
		return nil, errors.New("DPAPI call failed")
	}
	if outBlob.pbData == nil || outBlob.cbData == 0 {
		return nil, errors.New("DPAPI returned an empty blob")
	}
	out := unsafe.Slice(outBlob.pbData, int(outBlob.cbData))
	res := make([]byte, len(out))
	copy(res, out)
	procLocalFree.Call(uintptr(unsafe.Pointer(outBlob.pbData)))
	return res, nil
}
