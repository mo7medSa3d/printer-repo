//go:build windows

package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildSecureSDDL(t *testing.T) {
	// Service path (e.g. ProgramData)
	serviceSDDL, err := BuildSecureSDDL(`C:\ProgramData\OdooPrintAgent`)
	if err != nil {
		t.Fatalf("BuildSecureSDDL service path failed: %v", err)
	}
	expectedService := "D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)"
	if serviceSDDL != expectedService {
		t.Errorf("BuildSecureSDDL service path = %q, want %q", serviceSDDL, expectedService)
	}
	if strings.Contains(serviceSDDL, ";;;BU)") || strings.Contains(serviceSDDL, ";;;BG)") {
		t.Fatalf("service data ACL must not grant write/read access to broad built-in groups: %q", serviceSDDL)
	}

	// User path (e.g. AppData)
	userSDDL, err := BuildSecureSDDL(`C:\Users\CurrentUser\AppData\Local\OdooPrintAgent`)
	if err != nil {
		t.Fatalf("BuildSecureSDDL user path failed: %v", err)
	}
	if !strings.HasPrefix(userSDDL, "D:P(A;OICI;GA;;;S-1-") {
		t.Errorf("BuildSecureSDDL user path expected current user SID, got %q", userSDDL)
	}
	if !strings.HasSuffix(userSDDL, "(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)") {
		t.Errorf("BuildSecureSDDL user path missing SYSTEM/Administrators ACEs: %q", userSDDL)
	}
}

func TestEnsureSecureDirectoryACL_Windows(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureSecureDirectoryACL(dir); err != nil {
		t.Fatalf("EnsureSecureDirectoryACL failed on temp dir: %v", err)
	}
	file := filepath.Join(dir, "secret.dat")
	if err := os.WriteFile(file, []byte("secret"), 0600); err != nil {
		t.Fatalf("write test file: %v", err)
	}
	if err := EnsureSecureFileACL(file); err != nil {
		t.Fatalf("EnsureSecureFileACL failed: %v", err)
	}
}
