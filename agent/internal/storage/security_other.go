//go:build !windows

package storage

import (
	"os"
)

// EnsureSecureDirectoryACL sets restrictive owner-only permissions (0700) on POSIX.
func EnsureSecureDirectoryACL(path string) error {
	return os.Chmod(path, 0700)
}

// EnsureSecureFileACL is a no-op on POSIX; restrictive file modes are applied when files are created.
func EnsureSecureFileACL(path string) error {
	return os.Chmod(path, 0600)
}
