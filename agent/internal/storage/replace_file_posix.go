//go:build !windows

package storage

import "os"

func replaceFile(src, dst string) error {
	return os.Rename(src, dst)
}
