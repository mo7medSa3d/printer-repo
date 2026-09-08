//go:build !windows

package storage

import (
	"os"
	"strings"
)

// IsUserDirectory checks if a path resides inside a user profile directory.
func IsUserDirectory(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, "appdata") || strings.Contains(lower, "users") || strings.Contains(lower, "userprofile") || strings.Contains(lower, "/home/")
}

// EnsureSecureDirectoryACL sets restrictive owner-only permissions (0700) on POSIX.
func EnsureSecureDirectoryACL(path string) error {
	return os.Chmod(path, 0700)
}
