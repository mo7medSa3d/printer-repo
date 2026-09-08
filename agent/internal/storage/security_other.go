//go:build !windows

package storage

import "os"

// EnsureSecureDirectoryACL sets restrictive owner-only permissions (0700) on POSIX.
func EnsureSecureDirectoryACL(path string) error {
	return os.Chmod(path, 0700)
}
