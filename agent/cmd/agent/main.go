package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/kardianos/service"
	"github.com/odoo-print-agent/agent/internal/agent"
	"github.com/odoo-print-agent/agent/internal/config"
)

type program struct {
	agent  *agent.Agent
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup // tracks the agent run goroutine for graceful stop
}

func (p *program) Start(s service.Service) error {
	p.ctx, p.cancel = context.WithCancel(context.Background())
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		if err := p.agent.Run(p.ctx); err != nil {
			log.Printf("Agent error: %v", err)
		}
	}()
	return nil
}

// Stop is invoked by the service manager (or on Ctrl+C in interactive mode).
// It cancels the agent, waits for in-flight print jobs to drain, and only
// then closes the SQLite queue so the database is never closed mid-write.
func (p *program) Stop(s service.Service) error {
	if p.cancel != nil {
		p.cancel()
	}
	p.wg.Wait()
	if p.agent != nil {
		if err := p.agent.Close(); err != nil {
			log.Printf("WARNING: closing local queue failed: %v", err)
		}
	}
	return nil
}

const (
	// maxLogBytes rotates agent.log once it grows past this size so a
	// long-running installation never fills ProgramData with logs.
	maxLogBytes     = 5 * 1024 * 1024 // 5 MiB
	maxRotatedFiles = 3
)

// rotateLogIfFull shifts agent.log -> agent.log.1 -> agent.log.2 ... keeping
// at most maxRotatedFiles rotated copies beside the live log.
func rotateLogIfFull(logPath string) {
	info, err := os.Stat(logPath)
	if err != nil || info.Size() <= maxLogBytes {
		return
	}
	_ = os.Remove(fmt.Sprintf("%s.%d", logPath, maxRotatedFiles))
	for i := maxRotatedFiles - 1; i >= 1; i-- {
		_ = os.Rename(fmt.Sprintf("%s.%d", logPath, i), fmt.Sprintf("%s.%d", logPath, i+1))
	}
	_ = os.Rename(logPath, fmt.Sprintf("%s.1", logPath))
}

// setupLogging opens a writable log file beside the config file
// (%PROGRAMDATA%\OdooPrintAgent\logs\agent.log on Windows). The agent never
// writes to Program Files; the config path is the writable runtime root.
func setupLogging(configPath string) (*os.File, error) {
	logDir := filepath.Dir(configPath)
	if logDir == "" || logDir == "." {
		exeDir, err := config.ExecutableDir()
		if err != nil {
			return nil, fmt.Errorf("resolve executable dir: %w", err)
		}
		logDir = exeDir
	}
	logDir = filepath.Join(logDir, "logs")
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return nil, fmt.Errorf("create log directory %s: %w", logDir, err)
	}
	logPath := filepath.Join(logDir, "agent.log")
	rotateLogIfFull(logPath)
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, fmt.Errorf("open log file %s: %w", logPath, err)
	}
	// Windows services have no usable stdout; log to the file only. The desktop
	// smoke tests read this file, so it is the authoritative diagnostic sink.
	log.SetOutput(f)
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	log.Printf("log file: %s", logPath)
	return f, nil
}

func main() {
	configPath := flag.String("config", config.DefaultConfigPath(), "Path to config file")
	svcFlag := flag.String("service", "", "Control the system service: install, uninstall, start, stop, restart")
	flag.Parse()

	// Ensure the writable runtime directory and a safe default config exist
	// before anything else opens a database or connects to the network.
	// If the default ProgramData path is not writable for a non-elevated user,
	// fall back to a per-user AppData path so a clean install still starts.
	effectiveConfigPath := *configPath
	if err := config.Ensure(effectiveConfigPath); err != nil {
		if *configPath == config.DefaultConfigPath() {
			local := config.LocalConfigPath()
			if localErr := config.Ensure(local); localErr == nil {
				log.Printf("WARNING: default config path not writable (%v); using per-user fallback %s", err, local)
				effectiveConfigPath = local
			} else {
				log.Fatalf("Failed to prepare config %s: %v", *configPath, err)
			}
		} else {
			log.Fatalf("Failed to prepare config %s: %v", *configPath, err)
		}
	}
	*configPath = effectiveConfigPath
	logFile, err := setupLogging(*configPath)
	if err != nil {
		log.Printf("WARNING: logging unavailable: %v", err)
	} else {
		defer logFile.Close()
	}

	log.Printf("Using config file: %s", *configPath)

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		log.Fatalf("Invalid config %s: %v", *configPath, err)
	}

	app, err := agent.New(cfg, *configPath)
	if err != nil {
		log.Fatalf("Failed to initialize agent: %v", err)
	}

	svcConfig := &service.Config{
		Name:         "OdooPrintAgent",
		DisplayName:  "Odoo Print Agent",
		Description:  "Local print gateway for Odoo ERP — outbound HTTPS/WSS only, no inbound ports.",
		Arguments:    []string{"-config", *configPath},
		Dependencies: []string{"Tcpip"},
	}

	prg := &program{agent: app}
	s, err := service.New(prg, svcConfig)
	if err != nil {
		log.Fatalf("Failed to create service wrapper: %v", err)
	}

	if *svcFlag != "" {
		action := strings.ToLower(strings.TrimSpace(*svcFlag))
		switch action {
		case "install", "uninstall", "start", "stop", "restart":
			if err := service.Control(s, action); err != nil {
				if action == "install" || action == "uninstall" {
					// kardianos/service surfaces "access is denied" when the
					// shell is not elevated; make the recovery path explicit.
					log.Printf("Hint: run the command from an elevated PowerShell (Run as Administrator).")
				}
				log.Fatalf("Service control %q failed: %v", action, err)
			}
			log.Printf("Service control %q completed", action)
			return
		default:
			log.Fatalf("Unknown service action %q. Valid actions: install, uninstall, start, stop, restart", action)
		}
	}

	logger, err := s.Logger(nil)
	if err != nil {
		log.Printf("WARNING: service logger unavailable: %v", err)
	}

	err = s.Run()
	if err != nil {
		log.Printf("Service run error: %v", err)
		if logger != nil {
			_ = logger.Error(err)
		}
	}
}
