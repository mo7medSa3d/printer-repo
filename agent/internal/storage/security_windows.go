//go:build windows

package storage

import (
	"fmt"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func getCurrentUserSID() (string, error) {
	tok, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer tok.Close()

	u, err := tok.GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String(), nil
}

// BuildSecureSDDL returns the appropriate SDDL depending on whether the directory is
// a per-user directory (%LOCALAPPDATA% / %USERPROFILE%) or a system-wide service directory (%ProgramData%).
func BuildSecureSDDL(path string) (string, error) {
	if IsUserDirectory(path) {
		userSID, err := getCurrentUserSID()
		if err != nil {
			return "", fmt.Errorf("failed to get current user SID: %w", err)
		}
		return fmt.Sprintf("D:P(A;OICI;GA;;;%s)(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)", userSID), nil
	}
	return "D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)", nil
}

// EnsureSecureDirectoryACL enforces strict NTFS permissions on the target directory.
// System-wide service data is writable only by SYSTEM and Administrators. A
// per-user data directory is writable by its owning user, SYSTEM and
// Administrators. Standard Users never receive write access to service data
// that is later consumed by a LocalSystem service.
func EnsureSecureDirectoryACL(path string) error {
	sddl, err := BuildSecureSDDL(path)
	if err != nil {
		return err
	}
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

// EnsureSecureFileACL protects one existing file with the same trust model as
// its parent directory. It is needed for files created before the directory
// ACL was hardened; directory protection alone does not rewrite an existing
// child object's explicit DACL.
func EnsureSecureFileACL(path string) error {
	sddl, err := BuildSecureSDDL(filepath.Dir(path))
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("failed to parse file SDDL: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("failed to get file DACL: %w", err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("failed to set secure NTFS permissions on %s: %w", path, err)
	}
	return nil
}
