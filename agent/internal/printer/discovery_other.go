//go:build !windows

package printer

func enumSpoolerPrintersPlatform() ([]DeviceInfo, error) {
	// On non-Windows, no native spooler. Return empty.
	// Manual registration + config still populate discovery.
	return nil, nil
}
