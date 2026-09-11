package printer

// Regression test for the discovery close-race panic:
// "panic: send on closed channel" in discoverLPRPrinters/discoverSNMPPrinters/
// discoverIPPviaTCP. The function closed `results` when its context expired
// while workers were still inside non-ctx-bound probe reads; on the worker's
// return BOTH select arms (send-on-closed-channel and ctx.Done) are ready and
// Go picks uniformly at random, so a straggler panics ~50% per late result.
//
// This test exercises the REAL function (discoverLPRPrinters) against a fake
// LPD server whose reply lands after the deadline. Without the fix the panic
// kills the test process (~certain over ITER iterations at p≈0.5 each).
//
// Needs permission to bind TCP 515: run the test inside a private network
// namespace, e.g.:
//   unshare -rn bash -c 'ip link set lo up; go test ./internal/printer -run TestLPRCloseRace -count=3 -v'
// Without that capability it self-skips (CI-safe).

import (
	"context"
	"net"
	"testing"
	"time"
)

func startSlowLPD(t *testing.T, delay time.Duration) (addr string, done func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:515")
	if err != nil {
		t.Skipf("cannot bind 127.0.0.1:515 (need `unshare -rn` + lo up): %v", err)
	}
	stopped := make(chan struct{})
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 16)
				_, _ = c.Read(buf) // consume "\x04raw\n"
				select {
				case <-time.After(delay):
					_, _ = c.Write([]byte{0x00}) // LPD ack -> probe returns a DeviceInfo
				case <-stopped:
				}
			}(conn)
		}
	}()
	return "127.0.0.1", func() { close(stopped); _ = ln.Close() }
}

func TestLPRCloseRace(t *testing.T) {
	// The fake server answers 350ms after the request; the discovery context
	// expires at 150ms -> the worker returns from probeLPRHost AFTER the
	// main path passed its select{done,ctx} branch, i.e. exactly the window
	// the panic lived in.
	addr, stop := startSlowLPD(t, 350*time.Millisecond)
	defer stop()

	const iterations = 5
	for i := 0; i < iterations; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
		res := discoverLPRPrinters(ctx, []string{addr})
		cancel()
		_ = res // bail path may legitimately return zero devices
	}
}
