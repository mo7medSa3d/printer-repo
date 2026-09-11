package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/kardianos/service"
	"github.com/odoo-print-agent/agent/internal/agent"
	"github.com/odoo-print-agent/agent/internal/config"
	"gopkg.in/natefinch/lumberjack.v2"
)

type program struct {
	configPath string
	agent      *agent.Agent
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup // tracks the agent run goroutine for graceful stop
}

func (p *program) Start(s service.Service) error {
	p.ctx, p.cancel = context.WithCancel(context.Background())
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()

		if err := config.Ensure(p.configPath); err != nil {
			log.Printf("Failed to prepare canonical config path %s: %v — waiting for resolution...", p.configPath, err)
			<-p.ctx.Done()
			return
		}

		// Attempt to load and validate configuration inside the service loop.
		// If unconfigured or invalid, do not crash the service (which causes SCM 1053 / restart loops);
		// instead, log and wait quietly in an Idle / Unpaired state.
		var cfg *config.Config
		backoff := 5 * time.Second
		maxBackoff := 60 * time.Second
		consecutiveParseErrors := 0
		const maxConsecutiveParseErrors = 5

		for {
			var err error
			cfg, err = config.Load(p.configPath)

			// Check if file exists first
			fileExists := true
			if os.IsNotExist(err) {
				fileExists = false
			}

			if err == nil && cfg != nil && cfg.Validate() == nil && cfg.Agent.ID != "" && cfg.Agent.Secret != "" {
				break
			}

			// Handle different error scenarios
			if err != nil {
				// Distinguish between missing file and parse/corruption errors
				if !fileExists {
					// Missing file is expected during initial setup - use exponential backoff
					log.Printf("Agent unconfigured at %s (config file missing) — idling in unpaired state...", p.configPath)
					consecutiveParseErrors = 0
				} else {
					// File exists but failed to parse - likely corruption
					consecutiveParseErrors++
					if consecutiveParseErrors >= maxConsecutiveParseErrors {
						log.Fatalf("Agent configuration at %s failed to parse after %d consecutive attempts (%v) — configuration file may be corrupted. Please restore from backup or re-pair the agent.", p.configPath, consecutiveParseErrors, err)
					}
					log.Printf("Agent configuration at %s failed to parse (%v) [attempt %d/%d] — configuration file may be corrupted...", p.configPath, err, consecutiveParseErrors, maxConsecutiveParseErrors)
				}
			} else if cfg == nil || cfg.Agent.ID == "" || cfg.Agent.Secret == "" {
				log.Printf("Agent at %s is unpaired (missing agent id/secret) — idling in unpaired state...", p.configPath)
				consecutiveParseErrors = 0
			} else if err := cfg.Validate(); err != nil {
				log.Printf("Agent configuration invalid (%v) — idling in unpaired state...", err)
				consecutiveParseErrors = 0
			}

			select {
			case <-p.ctx.Done():
				return
			case <-time.After(backoff):
				// Exponential backoff with cap for missing files and validation errors
				if backoff < maxBackoff {
					backoff *= 2
				}
			}
		}

		app, err := agent.New(cfg, p.configPath)
		if err != nil {
			log.Printf("Failed to initialize agent: %v — waiting for resolution...", err)
			<-p.ctx.Done()
			return
		}
		p.agent = app

		if err := p.agent.Run(p.ctx); err != nil {
			log.Printf("Agent error: %v", err)
		}
	}()
	return nil
}

// Stop is invoked by the service manager (or on Ctrl+C in interactive mode).
// It cancels the agent, waits for Run() to complete its bounded shutdown, and
// only then closes the SQLite queue so the database is never closed mid-write.
func (p *program) Stop(s service.Service) error {
	if p.cancel != nil {
		p.cancel()
	}
	// SCM control handling is time-bounded. Keep SQLite open until Run() has
	// returned; otherwise a late worker can touch a closed WAL-backed database.
	stopDone := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(stopDone)
	}()
	select {
	case <-stopDone:
		if p.agent != nil {
			if err := p.agent.Close(); err != nil {
				return fmt.Errorf("close local queue: %w", err)
			}
		}
		return nil
	case <-time.After(27 * time.Second):
		// Do not close SQLite while Run() may still be using it. Windows SCM
		// gives the service-control handler about 30s; returning an error here
		// preserves database integrity at the cost of SCM escalating the stop.
		log.Printf("ERROR: service stop exceeded 27s; refusing to close local queue while agent loop is still running")
		return fmt.Errorf("agent shutdown exceeded 27s; local queue left open")
	}
}

// setupLogging opens a continuously rotating log file beside the config file
// (%PROGRAMDATA%\OdooPrintAgent\logs\agent.log on Windows). The agent never
// writes to Program Files; the config path is the writable runtime root.
func setupLogging(configPath string) (*lumberjack.Logger, error) {
	logDir := filepath.Dir(configPath)
	if logDir == "" || logDir == "." {
		exeDir, err := config.ExecutableDir()
		if err != nil {
			return nil, fmt.Errorf("resolve executable dir: %w", err)
		}
		logDir = exeDir
	}
	logDir = filepath.Join(logDir, "logs")
	// 0700: agent logs describe locally attached hardware and job metadata.
	if err := os.MkdirAll(logDir, 0700); err != nil {
		return nil, fmt.Errorf("create log directory %s: %w", logDir, err)
	}
	if err := config.EnsureSecureDirectoryACL(logDir); err != nil {
		return nil, fmt.Errorf("secure log directory %s: %w", logDir, err)
	}
	logPath := filepath.Join(logDir, "agent.log")
	// Existing logs/backups may predate the hardened directory ACL; repair
	// their explicit file DACLs as well. New lumberjack files inherit the
	// protected directory ACL.
	if matches, err := filepath.Glob(filepath.Join(logDir, "agent*.log*")); err == nil {
		for _, path := range matches {
			if err := config.EnsureSecureFileACL(path); err != nil {
				return nil, fmt.Errorf("secure existing log %s: %w", path, err)
			}
		}
	}

	rotator := &lumberjack.Logger{
		Filename:   logPath,
		MaxSize:    10, // 10 megabytes max size
		MaxBackups: 3,
		LocalTime:  true,
		Compress:   false,
	}

	if service.Interactive() || os.Getenv("DOCKER_CONTAINER") != "" {
		log.SetOutput(io.MultiWriter(os.Stdout, rotator))
	} else {
		log.SetOutput(rotator)
	}
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	log.Printf("log file: %s", logPath)
	return rotator, nil
}

// configureServiceRecovery declares SCM failure actions so a crashed agent
// restarts itself (60s delay, 3 attempts, counter reset daily) instead of
// staying dead until an operator notices. kardianos/service does not expose
// failure actions, so this shells to sc.exe on Windows only. Warn-only: a
// recovery-config failure must never break an otherwise good install.
func configureServiceRecovery(serviceName string) {
	if runtime.GOOS != "windows" {
		return
	}
	sc, err := exec.LookPath("sc.exe")
	if err != nil {
		log.Printf("WARNING: sc.exe not found; service recovery actions not configured")
		return
	}
	// Arguments require mandatory space after '=': "reset= 86400" and "actions= restart/..." to prevent Windows Error 87
	out, err := exec.Command(sc, "failure", serviceName, "reset= 86400",
		"actions= restart/60000/restart/60000/restart/60000").CombinedOutput()
	if err != nil {
		log.Printf("WARNING: configuring service recovery actions failed: %v (%s)", err, strings.TrimSpace(string(out)))
		return
	}
	log.Printf("Service recovery actions configured (restart on crash)")
}

func handleServiceControl(rawAction, configPath string) error {
	svcConfig := &service.Config{
		Name:         "OdooPrintAgent",
		DisplayName:  "Odoo Print Agent",
		Description:  "Local print gateway for Odoo ERP — outbound HTTPS/WSS only, no inbound ports.",
		Arguments:    []string{"-config", configPath},
		Dependencies: []string{"Tcpip"},
	}
	prg := &program{configPath: configPath}
	s, err := service.New(prg, svcConfig)
	if err != nil {
		return fmt.Errorf("failed to create service wrapper: %w", err)
	}

	action := strings.ToLower(strings.TrimSpace(rawAction))
	switch action {
	case "status":
		status, err := s.Status()
		if err != nil {
			return fmt.Errorf("service status failed: %w", err)
		}
		switch status {
		case service.StatusRunning:
			fmt.Println("OdooPrintAgent service is running")
		case service.StatusStopped:
			fmt.Println("OdooPrintAgent service is stopped")
		default:
			fmt.Println("OdooPrintAgent service status is unknown")
		}
		return nil
	case "install":
		if err := s.Install(); err != nil {
			return fmt.Errorf("install service failed: %w", err)
		}
		configureServiceRecovery(svcConfig.Name)
		fmt.Println("OdooPrintAgent service installed successfully")
		return nil
	case "uninstall":
		if err := s.Uninstall(); err != nil {
			return fmt.Errorf("uninstall service failed: %w", err)
		}
		fmt.Println("OdooPrintAgent service uninstalled successfully")
		return nil
	case "start":
		if err := s.Start(); err != nil {
			return fmt.Errorf("start service failed: %w", err)
		}
		fmt.Println("OdooPrintAgent service started successfully")
		return nil
	case "stop":
		if err := s.Stop(); err != nil {
			return fmt.Errorf("stop service failed: %w", err)
		}
		fmt.Println("OdooPrintAgent service stopped successfully")
		return nil
	case "restart":
		if err := s.Restart(); err != nil {
			return fmt.Errorf("restart service failed: %w", err)
		}
		fmt.Println("OdooPrintAgent service restarted successfully")
		return nil
	default:
		return fmt.Errorf("unknown service action: %q (expected install, uninstall, start, stop, restart, status)", rawAction)
	}
}

func main() {
	configPath := flag.String("config", config.DefaultConfigPath(), "Path to config file")
	svcFlag := flag.String("service", "", "Control the system service: install, uninstall, start, stop, restart, status")
	flag.Parse()

	// 1. Service control path: dispatch immediately without reading config or initializing agent
	if *svcFlag != "" {
		if err := handleServiceControl(*svcFlag, *configPath); err != nil {
			log.Fatalf("Service action %q failed: %v", *svcFlag, err)
		}
		os.Exit(0)
	}

	// 2. Normal runtime path
	// Logging setup
	logRotator, err := setupLogging(*configPath)
	if err != nil {
		log.Printf("WARNING: logging unavailable: %v", err)
	} else {
		defer logRotator.Close()
	}

	log.Printf("Using config file: %s", *configPath)

	svcConfig := &service.Config{
		Name:         "OdooPrintAgent",
		DisplayName:  "Odoo Print Agent",
		Description:  "Local print gateway for Odoo ERP — outbound HTTPS/WSS only, no inbound ports.",
		Arguments:    []string{"-config", *configPath},
		Dependencies: []string{"Tcpip"},
	}

	prg := &program{configPath: *configPath}
	s, err := service.New(prg, svcConfig)
	if err != nil {
		log.Fatalf("Failed to create service wrapper: %v", err)
	}

	logger, err := s.Logger(nil)
	if err != nil {
		log.Printf("WARNING: service logger unavailable: %v", err)
	}

	// Invoke service.Run() early before performing fatal configuration exits.
	// If the configuration is missing or unverified, program.Start idles in an Unpaired state
	// rather than crashing out and triggering Windows SCM Error 1053.
	err = s.Run()
	if err != nil {
		log.Printf("Service run error: %v", err)
		if logger != nil {
			_ = logger.Error(err)
		}
	}
}
