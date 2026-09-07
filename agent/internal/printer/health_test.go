package printer

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestPreFlightHealthStatus(t *testing.T) {
	// Subtest 1: Offline / Unreachable port
	t.Run("OfflineUnreachable", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		err := PreFlightHealthCheck(ctx, "127.0.0.1:19993")
		if err == nil {
			t.Fatal("expected error connecting to closed port, got nil")
		}
		if !errors.Is(err, ErrPrinterOffline) {
			t.Fatalf("expected ErrPrinterOffline, got %v", err)
		}
	})

	// Subtest 2: Healthy ESC/POS Printer
	t.Run("HealthyStatus", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:19994")
		if err != nil {
			t.Fatalf("listen failed: %v", err)
		}
		defer ln.Close()

		go func() {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer conn.Close()

			cmd := make([]byte, 3)
			for i := 0; i < 3; i++ {
				if _, err := io.ReadFull(conn, cmd); err != nil {
					return
				}
				if !bytes.Equal(cmd[:2], []byte{0x10, 0x04}) {
					return
				}
				switch cmd[2] {
				case 1: // Printer status: online (bit 3 = 0, bits 1,4 = 1 -> 0x12)
					_, _ = conn.Write([]byte{0x12})
				case 2: // Offline status: cover closed, no paper end, no error (0x12)
					_, _ = conn.Write([]byte{0x12})
				case 4: // Paper status: paper present (bits 2,3 = 0, bits 5,6 = 0 -> 0x12)
					_, _ = conn.Write([]byte{0x12})
				}
			}
		}()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		err = PreFlightHealthCheck(ctx, ln.Addr().String())
		if err != nil {
			t.Fatalf("expected healthy pre-flight check, got err: %v", err)
		}
	})

	// Subtest 3: Paper Out Status
	t.Run("PaperOutStatus", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:19995")
		if err != nil {
			t.Fatalf("listen failed: %v", err)
		}
		defer ln.Close()

		go func() {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer conn.Close()

			cmd := make([]byte, 3)
			for i := 0; i < 3; i++ {
				if _, err := io.ReadFull(conn, cmd); err != nil {
					return
				}
				switch cmd[2] {
				case 1:
					_, _ = conn.Write([]byte{0x12}) // Online
				case 2:
					_, _ = conn.Write([]byte{0x12}) // Normal
				case 4:
					// Paper out: bits 5 and 6 are set (0x60 | 0x12 = 0x72)
					_, _ = conn.Write([]byte{0x72})
				}
			}
		}()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		err = PreFlightHealthCheck(ctx, ln.Addr().String())
		if err == nil {
			t.Fatal("expected paper out error, got nil")
		}
		if !errors.Is(err, ErrPrinterPaperOut) {
			t.Fatalf("expected ErrPrinterPaperOut, got %v", err)
		}
		if !strings.Contains(err.Error(), "ERR_PRINTER_PAPER_OUT") {
			t.Fatalf("expected error string to contain ERR_PRINTER_PAPER_OUT, got %s", err.Error())
		}
	})

	// Subtest 4: Cover Open Status
	t.Run("CoverOpenStatus", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:19997")
		if err != nil {
			t.Fatalf("listen failed: %v", err)
		}
		defer ln.Close()

		go func() {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer conn.Close()

			cmd := make([]byte, 3)
			for i := 0; i < 3; i++ {
				if _, err := io.ReadFull(conn, cmd); err != nil {
					return
				}
				switch cmd[2] {
				case 1:
					_, _ = conn.Write([]byte{0x12})
				case 2:
					// Cover open: bit 2 is set (0x04 | 0x12 = 0x16)
					_, _ = conn.Write([]byte{0x16})
				case 4:
					_, _ = conn.Write([]byte{0x12})
				}
			}
		}()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		err = PreFlightHealthCheck(ctx, ln.Addr().String())
		if err == nil {
			t.Fatal("expected cover open error, got nil")
		}
		if !errors.Is(err, ErrPrinterCoverOpen) {
			t.Fatalf("expected ErrPrinterCoverOpen, got %v", err)
		}
	})
}
