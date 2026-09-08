package printer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

var (
	ErrPrinterNotReady  = errors.New("ERR_PRINTER_NOT_READY")
	ErrPrinterPaperOut  = fmt.Errorf("%w: ERR_PRINTER_PAPER_OUT", ErrPrinterNotReady)
	ErrPrinterOffline   = fmt.Errorf("%w: ERR_PRINTER_OFFLINE", ErrPrinterNotReady)
	ErrPrinterCoverOpen = fmt.Errorf("%w: ERR_PRINTER_COVER_OPEN", ErrPrinterNotReady)
)

// ESC/POS DLE EOT status inquiry command bytes.
var (
	cmdInquirePrinterStatus = []byte{0x10, 0x04, 0x01}
	cmdInquireOfflineStatus = []byte{0x10, 0x04, 0x02}
	cmdInquirePaperStatus   = []byte{0x10, 0x04, 0x04}
)

// HealthStatus holds the detailed parsed hardware status flags of an ESC/POS printer.
type HealthStatus struct {
	Online       bool
	CoverOpen    bool
	PaperOut     bool
	PaperNearEnd bool
	Error        bool
}

// QueryHealthStatus inspects an active connection using ESC/POS DLE EOT sequences.
func QueryHealthStatus(rw io.ReadWriter) (*HealthStatus, error) {
	status := &HealthStatus{Online: true}

	// 1. Printer Status (DLE EOT 1)
	if _, err := rw.Write(cmdInquirePrinterStatus); err != nil {
		return nil, fmt.Errorf("%w: failed to write printer status inquiry: %v", ErrPrinterOffline, err)
	}
	buf := make([]byte, 1)
	if _, err := io.ReadFull(rw, buf); err != nil {
		return nil, fmt.Errorf("%w: failed to read printer status: %v", ErrPrinterOffline, err)
	}
	// Bit 3: Online (0) / Offline (1)
	if (buf[0] & 0x08) != 0 {
		status.Online = false
		return status, ErrPrinterOffline
	}

	// 2. Offline Status (DLE EOT 2)
	if _, err := rw.Write(cmdInquireOfflineStatus); err != nil {
		return nil, fmt.Errorf("%w: failed to write offline status inquiry: %v", ErrPrinterOffline, err)
	}
	if _, err := io.ReadFull(rw, buf); err != nil {
		return nil, fmt.Errorf("%w: failed to read offline status: %v", ErrPrinterOffline, err)
	}
	// Bit 2: Cover open (1)
	if (buf[0] & 0x04) != 0 {
		status.CoverOpen = true
		return status, ErrPrinterCoverOpen
	}
	// Bit 5: Paper end stops printing (1)
	if (buf[0] & 0x20) != 0 {
		status.PaperOut = true
		return status, ErrPrinterPaperOut
	}
	// Bit 6: Error condition (1)
	if (buf[0] & 0x40) != 0 {
		status.Error = true
		return status, ErrPrinterOffline
	}

	// 3. Paper Status (DLE EOT 4)
	if _, err := rw.Write(cmdInquirePaperStatus); err != nil {
		return nil, fmt.Errorf("%w: failed to write paper status inquiry: %v", ErrPrinterOffline, err)
	}
	if _, err := io.ReadFull(rw, buf); err != nil {
		return nil, fmt.Errorf("%w: failed to read paper status: %v", ErrPrinterOffline, err)
	}
	// Bits 2 and 3: Paper roll near-end sensor
	if (buf[0] & 0x0C) != 0 {
		status.PaperNearEnd = true
	}
	// Bits 5 and 6: Paper roll end sensor (paper out when bits 5 & 6 are 1 -> 0x60)
	if (buf[0] & 0x60) != 0 {
		status.PaperOut = true
		return status, ErrPrinterPaperOut
	}

	return status, nil
}

// PreFlightHealthCheck dials the printer address and verifies online and paper status.
// Returns nil if printer is ready, or a typed error (ErrPrinterPaperOut, ErrPrinterOffline, ErrPrinterCoverOpen).
func PreFlightHealthCheck(ctx context.Context, address string) error {
	d := net.Dialer{Timeout: 2 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", address)
	if err != nil {
		return fmt.Errorf("%w: dial %s: %v", ErrPrinterOffline, address, err)
	}
	defer conn.Close()

	deadline := time.Now().Add(2 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)

	_, err = QueryHealthStatus(conn)
	return err
}
