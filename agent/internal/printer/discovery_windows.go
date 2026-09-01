//go:build windows

package printer

func enumSpoolerPrintersPlatform() ([]DeviceInfo, error) {
	// Use real Windows enumeration if available; fall back to empty on error.
	infos, err := EnumSpoolerPrinters()
	if err != nil {
		return nil, err
	}
	return infos, nil
}
