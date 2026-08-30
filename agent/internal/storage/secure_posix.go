//go:build !windows

package storage

// platformEncrypt/platformDecrypt are an identity transform on non-Windows
// platforms; the store file is simply written with 0600 permissions and
// base64 framing. This is a development/CI fallback only — production
// Windows builds use DPAPI (secure_windows.go).
func platformEncrypt(data []byte) ([]byte, error) {
	out := make([]byte, len(data))
	copy(out, data)
	return out, nil
}

func platformDecrypt(data []byte) ([]byte, error) {
	out := make([]byte, len(data))
	copy(out, data)
	return out, nil
}
