//go:build windows

package config

import (
	"fmt"
	"syscall"
	"time"
	"unsafe"
)

const (
	moveFileReplaceExisting = 0x1
	moveFileCopyAllowed     = 0x2
	moveFileWriteThrough    = 0x8
)

var procMoveFileExW = syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")

func replaceFile(src, dst string) error {
	from, err := syscall.UTF16PtrFromString(src)
	if err != nil {
		return err
	}
	to, err := syscall.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}

	flags := uintptr(moveFileReplaceExisting | moveFileCopyAllowed | moveFileWriteThrough)

	// Retry with exponential backoff on transient Windows file lock contention (e.g. antivirus, desktop scanner)
	const maxAttempts = 3
	backoff := 50 * time.Millisecond

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		r, _, callErr := procMoveFileExW.Call(
			uintptr(unsafe.Pointer(from)),
			uintptr(unsafe.Pointer(to)),
			flags,
		)
		if r != 0 {
			return nil
		}
		if callErr != nil {
			lastErr = callErr
		} else {
			lastErr = fmt.Errorf("MoveFileExW failed")
		}

		if attempt < maxAttempts {
			time.Sleep(backoff)
			backoff *= 2
		}
	}
	return fmt.Errorf("MoveFileExW failed after %d attempts: %w", maxAttempts, lastErr)
}
