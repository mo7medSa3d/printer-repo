//go:build windows

package storage

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// EnsureSecureDirectoryACL enforces strict NTFS permissions on the target directory.
// It removes inherited permissions and grants Full Control strictly to:
// - NT AUTHORITY\SYSTEM (SY)
// - BUILTIN\Administrators (BA)
// SDDL: D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)
func EnsureSecureDirectoryACL(path string) error {
	sddl := "D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)"
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("failed to parse SDDL %q: %w", sddl, err)
	}

	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("failed to get DACL: %w", err)
	}

	err = windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		dacl,
		nil,
	)
	if err != nil {
		return fmt.Errorf("failed to set secure NTFS permissions on %s: %w", path, err)
	}
	return nil
}
