package main

import (
	"context"
	"flag"

	"log"


	"github.com/kardianos/service"
	"github.com/odoo-print-agent/agent/internal/agent"
	"github.com/odoo-print-agent/agent/internal/config"
)

type program struct {
	agent *agent.Agent
	cfg   *config.Config
	ctx   context.Context
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
	p.cancel()
	return nil
}

func main() {
	configPath := flag.String("config", config.DefaultConfigPath(), "Path to config file")
	svcFlag := flag.String("service", "", "Control the system service: install, uninstall, start, stop")
	flag.Parse()

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
		Option: service.KeyValue{
			// Least-privilege log dir; kardianos/service creates it with correct ACLs on install.
			// Actual dir: C:\ProgramData\OdooPrintAgent\logs (resolved at runtime on Windows).
		},
	}

	prg := &program{
		agent: app,
		cfg:   cfg,
	}
	s, err := service.New(prg, svcConfig)
	if err != nil {
		log.Fatal(err)
	}

	if *svcFlag != "" {
		err = service.Control(s, *svcFlag)
		if err != nil {
			log.Printf("Valid actions: %q\n", service.ControlAction)
			log.Fatal(err)
		}
		return
	}

		logger, err := s.Logger(nil)
	if err != nil {
		log.Fatal(err)
	}

	err = s.Run()
	if err != nil {
		// s.Logger may be eventlog on Windows; also emit to stderr for diagnostics
		log.Printf("Service run error: %v", err)
		logger.Error(err)
	}
}
