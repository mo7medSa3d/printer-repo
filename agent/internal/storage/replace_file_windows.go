//go:build windows

package storage

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	moveFileReplaceExisting = 0x1
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
	r, _, callErr := procMoveFileExW.Call(
		uintptr(unsafe.Pointer(from)),
		uintptr(unsafe.Pointer(to)),
		moveFileReplaceExisting|moveFileWriteThrough,
	)
	if r == 0 {
		if callErr != nil {
			return fmt.Errorf("MoveFileExW failed: %w", callErr)
		}
		return fmt.Errorf("MoveFileExW failed")
	}
	return nil
}
