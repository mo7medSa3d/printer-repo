package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/kardianos/service"
	"github.com/odoo-print-agent/agent/internal/agent"
	"github.com/odoo-print-agent/agent/internal/config"
)

type program struct {
	agent  *agent.Agent
	cfg    *config.Config
	ctx    context.Context
	cancel context.CancelFunc
}

func (p *program) Start(s service.Service) error {
	p.ctx, p.cancel = context.WithCancel(context.Background())
	go p.run()
	return nil
}

func (p *program) run() {
	if err := p.agent.Run(p.ctx); err != nil {
		log.Printf("Agent error: %v", err)
	}
}

func (p *program) Stop(s service.Service) error {
	if p.cancel != nil {
		p.cancel()
	}
	return nil
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
		Name:        "OdooPrintAgent",
		DisplayName: "Odoo Print Agent",
		Description: "Local print gateway for Odoo ERP — outbound HTTPS/WSS only, no inbound ports.",
		Arguments:   []string{"-config", *configPath},
		Dependencies: []string{"Tcpip"},
	}

	prg := &program{
		agent: app,
		cfg:   cfg,
	}
	s, err := service.New(prg, svcConfig)
	if err != nil {
		log.Fatalf("Failed to create service wrapper: %v", err)
	}

	if *svcFlag != "" {
		switch strings.ToLower(strings.TrimSpace(*svcFlag)) {
		case "install", "uninstall":
			// Both require administrator access. kardianos/service returns a
			// clear "access is denied" error on Windows when not elevated; we
			// surface that explicitly instead of swallowing it.
			if err := service.Control(s, *svcFlag); err != nil {
				log.Printf("Service control %q failed: %v", *svcFlag, err)
				log.Printf("Hint: run the command from an elevated PowerShell (Run as Administrator).")
				log.Fatalf("Service control %q failed: %v", *svcFlag, err)
			}
		case "start", "stop", "restart":
			if err := service.Control(s, *svcFlag); err != nil {
				log.Printf("Service control %q failed: %v", *svcFlag, err)
				log.Fatalf("Service control %q failed: %v", *svcFlag, err)
			}
		default:
			log.Printf("Valid actions: %q\n", service.ControlAction)
			log.Fatalf("Unknown service action %q", *svcFlag)
		}
		log.Printf("Service control %q completed", *svcFlag)
		return
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
