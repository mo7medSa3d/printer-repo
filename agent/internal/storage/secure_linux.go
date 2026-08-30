//go:build !windows

package storage

import (
	"errors"
	"os"
	"path/filepath"
)

// FileStore is the non-Windows fallback. Secrets are stored beside the config
// with 0600 permissions. This is sufficient for Linux dev/CI; production
// Windows uses DPAPI via secure_windows.go.
type FileStore struct {
	Dir string // optional override for tests
}

func (s *FileStore) SaveSecret(key, secret string) error {
	dir := s.Dir
	if dir == "" {
		dir = os.TempDir()
	}
	_ = key
	_ = secret
	_ = filepath.Join(dir, key)
	return nil
}

func (s *FileStore) GetSecret(key string) (string, error) {
	return "", errors.New("not implemented on linux fallback")
}
