// Package testutil provides TEST-ONLY mock infrastructure. Never import from production code.
package testutil

import (
	"io"
	"net"
	"sync"
	"time"
)

// MockTCPPrinter listens on 127.0.0.1:9100 (or ephemeral) and captures bytes.
// Supports failure modes: refuse, delay, disconnect mid-write.
// Test-only; production code must never import testutil.
type MockTCPPrinter struct {
	Addr string
	ln   net.Listener
	mu   sync.Mutex
	// captured payloads, one per connection
	captured [][]byte
	// behavior knobs
	delay            time.Duration
	disconnectAfter  int // if >0, close after reading N bytes
	acceptFail       bool
	partialReadLimit int // if >0, read only N bytes then stall
	closed           bool
}

func NewMockTCPPrinter(addr string) *MockTCPPrinter {
	if addr == "" {
		addr = "127.0.0.1:9100"
	}
	return &MockTCPPrinter{Addr: addr}
}

func (m *MockTCPPrinter) Start() error {
	ln, err := net.Listen("tcp", m.Addr)
	if err != nil {
		return err
	}
	m.ln = ln
	m.Addr = ln.Addr().String()
	go m.acceptLoop()
	return nil
}

func (m *MockTCPPrinter) acceptLoop() {
	for {
		conn, err := m.ln.Accept()
		if err != nil {
			return
		}
		if m.acceptFail {
			conn.Close()
			continue
		}
		go m.handle(conn)
	}
}

func (m *MockTCPPrinter) handle(conn net.Conn) {
	defer conn.Close()
	if m.delay > 0 {
		time.Sleep(m.delay)
	}
	// read all, capture
	data, _ := io.ReadAll(conn)
	if m.disconnectAfter > 0 && len(data) > m.disconnectAfter {
		data = data[:m.disconnectAfter]
	}
	if m.partialReadLimit > 0 && len(data) > m.partialReadLimit {
		data = data[:m.partialReadLimit]
		// stall to simulate timeout
		time.Sleep(100 * time.Millisecond)
	}
	m.mu.Lock()
	m.captured = append(m.captured, data)
	m.mu.Unlock()
}

func (m *MockTCPPrinter) Captured() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([][]byte, len(m.captured))
	for i, c := range m.captured {
		cp := make([]byte, len(c))
		copy(cp, c)
		out[i] = cp
	}
	return out
}

func (m *MockTCPPrinter) CapturedFlat() []byte {
	var flat []byte
	for _, c := range m.Captured() {
		flat = append(flat, c...)
	}
	return flat
}

func (m *MockTCPPrinter) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.captured)
}

func (m *MockTCPPrinter) Reset() {
	m.mu.Lock()
	m.captured = nil
	m.mu.Unlock()
}

func (m *MockTCPPrinter) SetDelay(d time.Duration) { m.delay = d }
func (m *MockTCPPrinter) SetAcceptFail(v bool)    { m.acceptFail = v }
func (m *MockTCPPrinter) SetDisconnectAfter(n int) { m.disconnectAfter = n }
func (m *MockTCPPrinter) SetPartialReadLimit(n int) { m.partialReadLimit = n }

func (m *MockTCPPrinter) Close() error {
	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	if m.ln != nil {
		return m.ln.Close()
	}
	return nil
}

// WaitForCaptures blocks until at least want captures or timeout.
func (m *MockTCPPrinter) WaitForCaptures(want int, timeout time.Duration) [][]byte {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if m.Count() >= want {
			return m.Captured()
		}
		time.Sleep(20 * time.Millisecond)
	}
	return m.Captured()
}
