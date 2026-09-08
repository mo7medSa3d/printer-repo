//go:build windows

package config

import "github.com/odoo-print-agent/agent/internal/storage"

// EnsureSecureDirectoryACL forwards to storage.EnsureSecureDirectoryACL.
func EnsureSecureDirectoryACL(path string) error {
	return storage.EnsureSecureDirectoryACL(path)
}
