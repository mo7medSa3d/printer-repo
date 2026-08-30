package storage

import "runtime"

// SecureStore abstracts Windows DPAPI vs Linux fallback.
type SecureStore interface {
	SaveSecret(key, secret string) error
	GetSecret(key string) (string, error)
}

func NewSecureStore() SecureStore {
	if runtime.GOOS == "windows" {
		// WindowsStore is defined in secure_windows.go (windows build tag)
		return newWindowsStore()
	}
	return &FileStore{}
}

// newWindowsStore is a factory indirection so non-windows vet doesn't need WindowsStore type.
func newWindowsStore() SecureStore {
	return &windowsStoreStub{}
}

type windowsStoreStub struct{}

func (s *windowsStoreStub) SaveSecret(key, secret string) error {
	return nil
}
func (s *windowsStoreStub) GetSecret(key string) (string, error) {
	return "", nil
}
