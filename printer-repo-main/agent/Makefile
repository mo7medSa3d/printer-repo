.PHONY: all build-agent build-cli release test vet clean linux

BINARY_AGENT=OdooPrintAgent.exe
BINARY_CLI=odoo-agent-cli.exe

# Production flags: strip symbol/debug tables (-s -w) and remove local build
# paths (-trimpath) so shipped binaries are smaller and leak no build topology.
# NOTE: the agent links mattn/go-sqlite3 (CGO), so Windows .exe builds must run
# on a Windows host (or with a mingw cross toolchain), never with CGO_ENABLED=0.
RELEASE_FLAGS=-trimpath -ldflags "-s -w"

all: build-agent build-cli

build-agent:
	go build -o $(BINARY_AGENT) ./cmd/agent

build-cli:
	go build -o $(BINARY_CLI) ./cmd/cli

release:
	go build $(RELEASE_FLAGS) -o $(BINARY_AGENT) ./cmd/agent
	go build $(RELEASE_FLAGS) -o $(BINARY_CLI) ./cmd/cli

vet:
	go vet ./...

test: vet
	go test ./... -race -count=1

clean:
	rm -f $(BINARY_AGENT) $(BINARY_CLI)

# Cross-compilation for Linux (e.g. for Raspberry Pi — requires a working
# CGO cross toolchain for go-sqlite3, e.g. aarch64-linux-gnu-gcc).
linux:
	CC=aarch64-linux-gnu-gcc CGO_ENABLED=1 GOOS=linux GOARCH=arm64 go build -o odoo-agent-linux-arm64 ./cmd/agent
