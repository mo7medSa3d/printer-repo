.PHONY: all build-agent build-cli clean test

BINARY_AGENT=OdooPrintAgent.exe
BINARY_CLI=odoo-agent-cli.exe

all: build-agent build-cli

build-agent:
	go build -trimpath -o $(BINARY_AGENT) ./cmd/agent

build-cli:
	go build -trimpath -o $(BINARY_CLI) ./cmd/cli

test:
	go test ./internal/...

clean:
	rm -f $(BINARY_AGENT) $(BINARY_CLI)

# Cross-compilation for Linux (e.g. for Raspberry Pi)
linux:
	GOOS=linux GOARCH=arm64 go build -o odoo-agent-linux-arm64 ./cmd/agent
