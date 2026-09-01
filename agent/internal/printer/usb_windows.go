//go:build windows

package printer

import (
	"context"
	"fmt"
	"log"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type USBPrinter struct {
	ID           string
	Name         string
	VID          uint16
	PID          uint16
	SerialNumber string
	DevicePath   string
	USBLocation  string
}

func (p *USBPrinter) Identify() string {
	if p.SerialNumber != "" && p.SerialNumber != "0" {
		return fmt.Sprintf("USB-SN:%s", p.SerialNumber)
	}
	if p.USBLocation != "" {
		return fmt.Sprintf("USB-LOC:%s", p.USBLocation)
	}
	return fmt.Sprintf("USB-VIDPID:%04x:%04x", p.VID, p.PID)
}

func (p *USBPrinter) Print(ctx context.Context, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("payload %d exceeds %d limit", len(data), maxPrintBytes)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	if p.DevicePath == "" {
		return fmt.Errorf("USB device discovered (%s) but no Windows device path is available and no spooler queue is associated; install the printer as a Windows printer (Settings > Bluetooth & devices > Printers) and use type spooler with spooler_name %q. VID:%04x PID:%04x Serial:%q", p.Identify(), p.Name, p.VID, p.PID, p.SerialNumber)
	}
	pathPtr, err := syscall.UTF16PtrFromString(p.DevicePath)
	if err != nil {
		return fmt.Errorf("invalid device path %q: %w", p.DevicePath, err)
	}
	h, err := windows.CreateFile(pathPtr, windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return fmt.Errorf("CreateFile(%q) failed for %s: %w (try installing as Windows spooler queue)", p.DevicePath, p.Identify(), err)
	}
	defer windows.CloseHandle(h)
	written := 0
	for written < len(data) {
		select {
		case <-ctx.Done():
			return fmt.Errorf("print cancelled after %d/%d bytes: %w", written, len(data), ctx.Err())
		default:
		}
		var n uint32
		chunk := data[written:]
		if len(chunk) > 8192 {
			chunk = chunk[:8192]
		}
		err := windows.WriteFile(h, chunk, &n, nil)
		if err != nil {
			return fmt.Errorf("WriteFile to %s failed after %d/%d bytes: %w", p.DevicePath, written, len(data), err)
		}
		if n == 0 {
			return fmt.Errorf("WriteFile to %s wrote 0 bytes", p.DevicePath)
		}
		written += int(n)
	}
	log.Printf("Direct USB printed %d bytes to %s (%s)", written, p.DevicePath, p.Identify())
	return nil
}

func (p *USBPrinter) Test(ctx context.Context) error {
	return p.Print(ctx, []byte("\x1b\x40USB Direct Test Print for Odoo Agent\nPrinter: "+p.Name+"\nVID:"+fmt.Sprintf("%04x", p.VID)+" PID:"+fmt.Sprintf("%04x", p.PID)+"\n\n\x1d\x56\x01"))
}

func (p *USBPrinter) Status() string {
	if p.DevicePath == "" {
		return "unknown"
	}
	pathPtr, err := syscall.UTF16PtrFromString(p.DevicePath)
	if err != nil {
		return "error"
	}
	h, err := windows.CreateFile(pathPtr, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return "offline"
	}
	windows.CloseHandle(h)
	return "online"
}

const (
	digcfPresent             = 0x00000002
	digcfAllClasses          = 0x00000004
	digcfDeviceInterface     = 0x00000010
	spdrpHardwareID          = 0x00000001
	spdrpCompatibleIDs       = 0x00000002
	spdrpDeviceDesc          = 0x00000000
	spdrpFriendlyName        = 0x0000000C
	spdrpLocationInformation = 0x0000000D
	spdrpMfg                 = 0x0000000B
	spdrpClass               = 0x00000007
	spdrpClassGuid           = 0x00000008
)

var (
	modSetupAPI                           = syscall.NewLazyDLL("setupapi.dll")
	procSetupDiGetClassDevsW              = modSetupAPI.NewProc("SetupDiGetClassDevsW")
	procSetupDiEnumDeviceInfo             = modSetupAPI.NewProc("SetupDiEnumDeviceInfo")
	procSetupDiGetDeviceInstanceIdW       = modSetupAPI.NewProc("SetupDiGetDeviceInstanceIdW")
	procSetupDiGetDeviceRegistryPropertyW = modSetupAPI.NewProc("SetupDiGetDeviceRegistryPropertyW")
	procSetupDiDestroyDeviceInfoList      = modSetupAPI.NewProc("SetupDiDestroyDeviceInfoList")
	procSetupDiEnumDeviceInterfaces       = modSetupAPI.NewProc("SetupDiEnumDeviceInterfaces")
	procSetupDiGetDeviceInterfaceDetailW  = modSetupAPI.NewProc("SetupDiGetDeviceInterfaceDetailW")
)

type spDevInfoData struct {
	cbSize    uint32
	ClassGuid windows.GUID
	DevInst   uint32
	Reserved  uintptr
}

type spDeviceInterfaceData struct {
	cbSize             uint32
	InterfaceClassGuid windows.GUID
	Flags              uint32
	Reserved           uintptr
}

var guidDevInterfaceUSBPrint = windows.GUID{Data1: 0x28d78fad, Data2: 0x100a, Data3: 0x48d4, Data4: [8]byte{0xa4, 0x89, 0x38, 0xd5, 0xbe, 0xd3, 0x41, 0xb0}}
var guidDevInterfaceUSBDevice = windows.GUID{Data1: 0xA5DCBF10, Data2: 0x6530, Data3: 0x11D2, Data4: [8]byte{0x90, 0x1F, 0x00, 0xC0, 0x4F, 0xB9, 0x51, 0xED}}

func discoverUSBPrinters() ([]DeviceInfo, error) {
	log.Printf("[discovery] starting USB discovery (SetupDi)")
	pathMap := buildUSBDevicePathMap()

	// Prefer printer-specific interface GUID; fallback to ALLCLASSES with strict filtering
	handle, _, err := procSetupDiGetClassDevsW.Call(uintptr(unsafe.Pointer(&guidDevInterfaceUSBPrint)), 0, 0, uintptr(digcfPresent|digcfDeviceInterface))
	if handle == uintptr(0) || handle == uintptr(^uint32(0)) {
		return nil, fmt.Errorf("SetupDiGetClassDevsW failed: %v", err)
	}
	defer procSetupDiDestroyDeviceInfoList.Call(handle)

	var infos []DeviceInfo
	seenIDs := make(map[string]bool)

	for idx := 0; ; idx++ {
		var devInfo spDevInfoData
		devInfo.cbSize = uint32(unsafe.Sizeof(devInfo))
		ret, _, _ := procSetupDiEnumDeviceInfo.Call(handle, uintptr(idx), uintptr(unsafe.Pointer(&devInfo)))
		if ret == 0 {
			break
		}
		instanceID, err := getDeviceInstanceID(handle, &devInfo)
		if err != nil || instanceID == "" {
			continue
		}
		upperID := strings.ToUpper(instanceID)
		isUSB := strings.Contains(upperID, "USB\\VID_") || strings.Contains(upperID, "USBPRINT") || strings.Contains(upperID, "VID_") && strings.Contains(upperID, "PID_")
		if !isUSB {
			continue
		}
		hwIDs, _ := getDeviceRegistryProperty(handle, &devInfo, spdrpHardwareID)
		compatIDs, _ := getDeviceRegistryProperty(handle, &devInfo, spdrpCompatibleIDs)
		classVal, _ := getDeviceRegistryPropertySingle(handle, &devInfo, spdrpClass)
		if !isPrinterUSBDevice(hwIDs, compatIDs, classVal) {
			continue
		}
		vid, pid, serial := parseVIDPIDSerial(instanceID)
		friendlyName, _ := getDeviceRegistryPropertySingle(handle, &devInfo, spdrpFriendlyName)
		if friendlyName == "" {
			friendlyName, _ = getDeviceRegistryPropertySingle(handle, &devInfo, spdrpDeviceDesc)
		}
		mfg, _ := getDeviceRegistryPropertySingle(handle, &devInfo, spdrpMfg)
		location, _ := getDeviceRegistryPropertySingle(handle, &devInfo, spdrpLocationInformation)
		desc, _ := getDeviceRegistryPropertySingle(handle, &devInfo, spdrpDeviceDesc)
		if friendlyName == "" {
			friendlyName = desc
		}
		if friendlyName == "" {
			friendlyName = fmt.Sprintf("USB Printer %04X:%04X", vid, pid)
		}
		friendlyName = strings.TrimSpace(friendlyName)
		if mfg != "" && !strings.Contains(strings.ToLower(friendlyName), strings.ToLower(mfg)) {
			friendlyName = mfg + " " + friendlyName
		}
		vidStr := fmt.Sprintf("%04x", vid)
		pidStr := fmt.Sprintf("%04x", pid)
		id := StableIDFromUSB(vidStr, pidStr, serial, location)
		if seenIDs[id] {
			continue
		}
		seenIDs[id] = true

		devicePath := pathMap[instanceID]
		if devicePath == "" {
			for k, v := range pathMap {
				if strings.EqualFold(k, instanceID) {
					devicePath = v
					break
				}
			}
		}
		if devicePath == "" {
			continue
		}

		caps := map[string]interface{}{}
		caps["hardware_ids"] = hwIDs
		caps["compatible_ids"] = compatIDs
		caps["device_instance_id"] = instanceID
		if mfg != "" {
			caps["manufacturer"] = mfg
		}
		if desc != "" {
			caps["device_desc"] = desc
		}
		if location != "" {
			caps["location"] = location
		}
		if devicePath != "" {
			caps["device_path"] = devicePath
			caps["direct_usb_available"] = true
			caps["requires_spooler"] = false
		} else {
			caps["diagnostic"] = "USB device discovered, no device path found; install as Windows spooler queue or ensure driver exposes USBPRINT interface"
			caps["requires_spooler"] = true
			caps["direct_usb_available"] = false
		}

		di := DeviceInfo{
			ID:             id,
			Name:           friendlyName,
			DisplayName:    friendlyName,
			PrinterType:    "unknown",
			ConnectionType: "usb",
			Protocol:       "raw",
			Endpoint:       devicePath,
			SpoolerName:    "",
			USBVID:         vidStr,
			USBPID:         pidStr,
			USBSerial:      serial,
			Status:         "unknown",
			Enabled:        true,
			Capabilities:   caps,
			Type:           "usb",
		}
		if devicePath == "" {
			di.Endpoint = instanceID
		}
		lowerName := strings.ToLower(friendlyName + " " + desc + " " + mfg)
		if strings.Contains(lowerName, "thermal") || strings.Contains(lowerName, "receipt") || strings.Contains(lowerName, "pos") {
			di.PrinterType = "thermal"
		} else if strings.Contains(lowerName, "label") || strings.Contains(lowerName, "zebra") {
			di.PrinterType = "label"
		} else if strings.Contains(lowerName, "laser") {
			di.PrinterType = "laser"
		} else if strings.Contains(lowerName, "inkjet") || strings.Contains(lowerName, "deskjet") {
			di.PrinterType = "inkjet"
		}
		if devicePath != "" {
			di.Status = "online"
		}
		log.Printf("[discovery] found USB printer: %q VID:%04x PID:%04x serial:%q location:%q path:%q -> %s", friendlyName, vid, pid, serial, location, devicePath, id)
		infos = append(infos, di)
	}
	// Fallback enumeration via ALLCLASSES with strict filtering to catch vendor-specific
	// printers that do not expose GUID_DEVINTERFACE_USBPRINT but still have Class_07.
	// This path is only taken if primary found nothing, to avoid re-enumerating hundreds
	// of devices when primary succeeded.
	if len(infos) == 0 {
		fbHandle, _, _ := procSetupDiGetClassDevsW.Call(0, 0, 0, uintptr(digcfPresent|digcfAllClasses))
		if fbHandle != uintptr(0) && fbHandle != uintptr(^uint32(0)) {
			defer procSetupDiDestroyDeviceInfoList.Call(fbHandle)
			for idx := 0; ; idx++ {
				var devInfo spDevInfoData
				devInfo.cbSize = uint32(unsafe.Sizeof(devInfo))
				ret, _, _ := procSetupDiEnumDeviceInfo.Call(fbHandle, uintptr(idx), uintptr(unsafe.Pointer(&devInfo)))
				if ret == 0 {
					break
				}
				instanceID, err := getDeviceInstanceID(fbHandle, &devInfo)
				if err != nil || instanceID == "" {
					continue
				}
				upperID := strings.ToUpper(instanceID)
				if !(strings.Contains(upperID, "USB\\VID_") || strings.Contains(upperID, "USBPRINT")) {
					continue
				}
				hwIDs, _ := getDeviceRegistryProperty(fbHandle, &devInfo, spdrpHardwareID)
				compatIDs, _ := getDeviceRegistryProperty(fbHandle, &devInfo, spdrpCompatibleIDs)
				classVal, _ := getDeviceRegistryPropertySingle(fbHandle, &devInfo, spdrpClass)
				if !isPrinterUSBDevice(hwIDs, compatIDs, classVal) {
					continue
				}
				vid, pid, serial := parseVIDPIDSerial(instanceID)
				friendlyName, _ := getDeviceRegistryPropertySingle(fbHandle, &devInfo, spdrpFriendlyName)
				if friendlyName == "" {
					friendlyName, _ = getDeviceRegistryPropertySingle(fbHandle, &devInfo, spdrpDeviceDesc)
				}
				mfg, _ := getDeviceRegistryPropertySingle(fbHandle, &devInfo, spdrpMfg)
				location, _ := getDeviceRegistryPropertySingle(fbHandle, &devInfo, spdrpLocationInformation)
				desc, _ := getDeviceRegistryPropertySingle(fbHandle, &devInfo, spdrpDeviceDesc)
				if friendlyName == "" {
					friendlyName = desc
				}
				if friendlyName == "" {
					friendlyName = fmt.Sprintf("USB Printer %04X:%04X", vid, pid)
				}
				friendlyName = strings.TrimSpace(friendlyName)
				if mfg != "" && !strings.Contains(strings.ToLower(friendlyName), strings.ToLower(mfg)) {
					friendlyName = mfg + " " + friendlyName
				}
				vidStr := fmt.Sprintf("%04x", vid)
				pidStr := fmt.Sprintf("%04x", pid)
				id := StableIDFromUSB(vidStr, pidStr, serial, location)
				if seenIDs[id] {
					continue
				}
				seenIDs[id] = true
				devicePath := pathMap[instanceID]
				if devicePath == "" {
					for k, v := range pathMap {
						if strings.EqualFold(k, instanceID) {
							devicePath = v
							break
						}
					}
				}
				if devicePath == "" {
					continue
				}
				caps := map[string]interface{}{}
				caps["hardware_ids"] = hwIDs
				caps["compatible_ids"] = compatIDs
				caps["device_instance_id"] = instanceID
				if mfg != "" {
					caps["manufacturer"] = mfg
				}
				if desc != "" {
					caps["device_desc"] = desc
				}
				if location != "" {
					caps["location"] = location
				}
				caps["device_path"] = devicePath
				caps["direct_usb_available"] = true
				caps["requires_spooler"] = false
				di := DeviceInfo{
					ID:             id,
					Name:           friendlyName,
					DisplayName:    friendlyName,
					PrinterType:    "unknown",
					ConnectionType: "usb",
					Protocol:       "raw",
					Endpoint:       devicePath,
					USBVID:         vidStr,
					USBPID:         pidStr,
					USBSerial:      serial,
					Status:         "online",
					Enabled:        true,
					Capabilities:   caps,
					Type:           "usb",
				}
				lowerName := strings.ToLower(friendlyName + " " + desc + " " + mfg)
				if strings.Contains(lowerName, "thermal") || strings.Contains(lowerName, "receipt") || strings.Contains(lowerName, "pos") {
					di.PrinterType = "thermal"
				} else if strings.Contains(lowerName, "label") || strings.Contains(lowerName, "zebra") {
					di.PrinterType = "label"
				} else if strings.Contains(lowerName, "laser") {
					di.PrinterType = "laser"
				} else if strings.Contains(lowerName, "inkjet") || strings.Contains(lowerName, "deskjet") {
					di.PrinterType = "inkjet"
				}
				log.Printf("[discovery] found USB printer via fallback: %q VID:%04x PID:%04x -> %s", friendlyName, vid, pid, id)
				infos = append(infos, di)
			}
		}
	}
	log.Printf("[discovery] USB discovery completed: %d devices", len(infos))
	return infos, nil
}

func buildUSBDevicePathMap() map[string]string {
	out := make(map[string]string)
	guids := []windows.GUID{guidDevInterfaceUSBPrint, guidDevInterfaceUSBDevice}
	for _, guid := range guids {
		handle, _, _ := procSetupDiGetClassDevsW.Call(uintptr(unsafe.Pointer(&guid)), 0, 0, uintptr(digcfPresent|digcfDeviceInterface))
		if handle == uintptr(0) || handle == uintptr(^uint32(0)) {
			continue
		}
		for idx := 0; ; idx++ {
			var ifData spDeviceInterfaceData
			ifData.cbSize = uint32(unsafe.Sizeof(ifData))
			ret, _, _ := procSetupDiEnumDeviceInterfaces.Call(handle, 0, uintptr(unsafe.Pointer(&guid)), uintptr(idx), uintptr(unsafe.Pointer(&ifData)))
			if ret == 0 {
				break
			}
			var required uint32
			procSetupDiGetDeviceInterfaceDetailW.Call(handle, uintptr(unsafe.Pointer(&ifData)), 0, 0, uintptr(unsafe.Pointer(&required)), 0)
			if required == 0 || required > 4096 {
				continue
			}
			buf := make([]byte, required)
			cbSize := 6
			if unsafe.Sizeof(uintptr(0)) == 8 {
				cbSize = 8
			}
			*(*uint32)(unsafe.Pointer(&buf[0])) = uint32(cbSize)
			var devInfo spDevInfoData
			devInfo.cbSize = uint32(unsafe.Sizeof(devInfo))
			ret, _, _ = procSetupDiGetDeviceInterfaceDetailW.Call(handle, uintptr(unsafe.Pointer(&ifData)), uintptr(unsafe.Pointer(&buf[0])), uintptr(required), uintptr(unsafe.Pointer(&required)), uintptr(unsafe.Pointer(&devInfo)))
			if ret == 0 {
				continue
			}
			pathPtr := (*uint16)(unsafe.Pointer(&buf[cbSize]))
			path := windows.UTF16PtrToString(pathPtr)
			instanceID, err := getDeviceInstanceID(handle, &devInfo)
			if err != nil || instanceID == "" {
				continue
			}
			if _, exists := out[instanceID]; !exists {
				out[instanceID] = path
			}
		}
		procSetupDiDestroyDeviceInfoList.Call(handle)
	}
	return out
}

func getDeviceInstanceID(handle uintptr, devInfo *spDevInfoData) (string, error) {
	var requiredSize uint32
	procSetupDiGetDeviceInstanceIdW.Call(handle, uintptr(unsafe.Pointer(devInfo)), 0, 0, uintptr(unsafe.Pointer(&requiredSize)))
	if requiredSize == 0 {
		return "", fmt.Errorf("no size")
	}
	buf := make([]uint16, requiredSize)
	ret, _, _ := procSetupDiGetDeviceInstanceIdW.Call(handle, uintptr(unsafe.Pointer(devInfo)), uintptr(unsafe.Pointer(&buf[0])), uintptr(requiredSize), uintptr(unsafe.Pointer(&requiredSize)))
	if ret == 0 {
		return "", fmt.Errorf("GetDeviceInstanceId failed")
	}
	return syscall.UTF16ToString(buf), nil
}

func getDeviceRegistryProperty(handle uintptr, devInfo *spDevInfoData, property uint32) ([]string, error) {
	var dataType uint32
	var requiredSize uint32
	ret, _, _ := procSetupDiGetDeviceRegistryPropertyW.Call(handle, uintptr(unsafe.Pointer(devInfo)), uintptr(property), uintptr(unsafe.Pointer(&dataType)), 0, 0, uintptr(unsafe.Pointer(&requiredSize)))
	if ret != 0 || requiredSize == 0 {
		return nil, fmt.Errorf("no data")
	}
	if requiredSize > 8192 {
		requiredSize = 8192
	}
	buf := make([]byte, requiredSize)
	ret, _, err := procSetupDiGetDeviceRegistryPropertyW.Call(handle, uintptr(unsafe.Pointer(devInfo)), uintptr(property), uintptr(unsafe.Pointer(&dataType)), uintptr(unsafe.Pointer(&buf[0])), uintptr(requiredSize), 0)
	if ret == 0 {
		if err == windows.ERROR_INSUFFICIENT_BUFFER || requiredSize == 0 {
			return nil, fmt.Errorf("buffer")
		}
		return nil, err
	}
	if dataType == 1 {
		u16 := (*[4096]uint16)(unsafe.Pointer(&buf[0]))[:requiredSize/2]
		n := 0
		for n < len(u16) && u16[n] != 0 {
			n++
		}
		return []string{syscall.UTF16ToString(u16[:n])}, nil
	} else if dataType == 7 {
		u16 := (*[4096]uint16)(unsafe.Pointer(&buf[0]))[:requiredSize/2]
		var out []string
		start := 0
		for i := 0; i < len(u16); i++ {
			if u16[i] == 0 {
				if i > start {
					out = append(out, syscall.UTF16ToString(u16[start:i]))
				}
				start = i + 1
				if i+1 < len(u16) && u16[i+1] == 0 {
					break
				}
			}
		}
		return out, nil
	}
	return nil, fmt.Errorf("unknown type %d", dataType)
}

func getDeviceRegistryPropertySingle(handle uintptr, devInfo *spDevInfoData, property uint32) (string, error) {
	vals, err := getDeviceRegistryProperty(handle, devInfo, property)
	if err != nil || len(vals) == 0 {
		return "", err
	}
	return vals[0], nil
}

func parseVIDPIDSerial(instanceID string) (vid uint16, pid uint16, serial string) {
	upper := strings.ToUpper(instanceID)
	vidIdx := strings.Index(upper, "VID_")
	if vidIdx >= 0 && len(upper) >= vidIdx+8 {
		fmt.Sscanf(upper[vidIdx:vidIdx+8], "VID_%04X", &vid)
	}
	pidIdx := strings.Index(upper, "PID_")
	if pidIdx >= 0 && len(upper) >= pidIdx+8 {
		fmt.Sscanf(upper[pidIdx:pidIdx+8], "PID_%04x", &pid)
		if pid == 0 {
			fmt.Sscanf(upper[pidIdx:pidIdx+8], "PID_%04X", &pid)
		}
	}
	if idx := strings.LastIndex(instanceID, "\\"); idx >= 0 && idx+1 < len(instanceID) {
		serial = instanceID[idx+1:]
		serial = strings.TrimSpace(serial)
		if serial == "0" || strings.EqualFold(serial, "00000000") {
			serial = ""
		}
	}
	return
}
