// Package storage persists small secrets (for example the agent pairing
// secret) next to the agent config file.
//
// On Windows values are sealed with DPAPI before they touch the disk
// (secure_windows.go, CURRENT_USER + LOCAL_MACHINE scope so both the desktop
// app and the LocalSystem service can read them). On other platforms a
// base64 file with owner-only permissions is used as a development fallback
// (secure_posix.go). The storage layer is platform-agnostic here and must
// never reference platform-only types so that `go build ./...` succeeds for
// every GOOS/GOARCH pair (this was a CI regression on windows-latest).
package storage

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const secretFile = "agent-secrets.dat"

// Store saves key/value secrets under Dir (the agent data directory, e.g.
// C:\ProgramData\OdooPrintAgent).
type Store struct {
	Dir string
}

// NewStore returns a Store that persists secrets inside dir.
func NewStore(dir string) *Store { return &Store{Dir: dir} }

func (s *Store) path() (string, error) {
	if strings.TrimSpace(s.Dir) == "" {
		return "", errors.New("storage: Dir is empty")
	}
	return filepath.Join(s.Dir, secretFile), nil
}

func validKey(key string) bool {
	if key == "" || len(key) > 64 {
		return false
	}
	for _, c := range key {
		switch {
		case c >= 'a' && c <= 'z':
		case c >= 'A' && c <= 'Z':
		case c >= '0' && c <= '9':
		case c == '_' || c == '.' || c == '-':
		default:
			return false
		}
	}
	return true
}

// SaveSecret seals secret under key and rewrites the store file atomically.
func (s *Store) SaveSecret(key, secret string) error {
	if !validKey(key) {
		return fmt.Errorf("storage: invalid key %q", key)
	}
	p, err := s.path()
	if err != nil {
		return err
	}
	dense, err := platformEncrypt([]byte(secret))
	if err != nil {
		return fmt.Errorf("storage: encrypt %q: %w", key, err)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return fmt.Errorf("storage: create dir %s: %w", filepath.Dir(p), err)
	}
	entries, err := readEntries(p)
	if err != nil {
		return err
	}
	encoded := base64.RawStdEncoding.EncodeToString(dense)
	replaced := false
	for i, e := range entries {
		if e.Key == key {
			entries[i].Value = encoded
			replaced = true
			break
		}
	}
	if !replaced {
		entries = append(entries, entry{Key: key, Value: encoded})
	}

	var b strings.Builder
	for _, e := range entries {
		b.WriteString(e.Key)
		b.WriteByte('=')
		b.WriteString(e.Value)
		b.WriteByte('\n')
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o600); err != nil {
		return fmt.Errorf("storage: write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("storage: replace %s: %w", p, err)
	}
	return nil
}

// GetSecret returns the secret stored under key. When the key has not been
// configured yet it returns an error that callers can detect with
// errors.Is(err, ErrNotFound).
func (s *Store) GetSecret(key string) (string, error) {
	p, err := s.path()
	if err != nil {
		return "", err
	}
	entries, err := readEntries(p)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if e.Key != key {
			continue
		}
		dense, err := base64.RawStdEncoding.DecodeString(e.Value)
		if err != nil {
			return "", fmt.Errorf("storage: decode %q: %w", key, err)
		}
		plain, err := platformDecrypt(dense)
		if err != nil {
			return "", fmt.Errorf("storage: decrypt %q: %w", key, err)
		}
		return string(plain), nil
	}
	return "", fmt.Errorf("storage: secret %q: %w", key, ErrNotFound)
}

// ErrNotFound is returned by GetSecret when no secret exists for a key.
var ErrNotFound = errors.New("not found")

type entry struct {
	Key   string
	Value string
}

func readEntries(p string) ([]entry, error) {
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("storage: read %s: %w", p, err)
	}
	var entries []entry
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || !validKey(k) {
			return nil, fmt.Errorf("storage: corrupt entry in %s", p)
		}
		entries = append(entries, entry{Key: k, Value: v})
	}
	return entries, nil
}
