package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server struct {
		URL string `yaml:"url"`
	} `yaml:"server"`
	Agent struct {
		ID     string `yaml:"id"`
		Secret string `yaml:"secret"`
		Name   string `yaml:"name"`
	} `yaml:"agent"`
	Printers []PrinterConfig `yaml:"printers"`
}

type PrinterConfig struct {
	ID         string `yaml:"id"`
	Name       string `yaml:"name"`
	Type       string `yaml:"type"` // "usb" or "network"
	Endpoint   string `yaml:"endpoint"` // IP:Port or USB Path
	Protocol   string `yaml:"protocol"` // "raw", "escpos", "ipp"
}

func Load(path string) (*Config, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Config{}, nil
		}
		return nil, err
	}
	defer f.Close()

	var cfg Config
	err = yaml.NewDecoder(f).Decode(&cfg)
	return &cfg, err
}

func (c *Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	return yaml.NewEncoder(f).Encode(c)
}

// ExecutableDir returns the directory containing the running binary,
// resolving symlinks where possible. Windows services are frequently
// started with an arbitrary (or empty/System32) working directory, so
// nothing that needs to survive a service restart should be resolved
// relative to os.Getwd().
func ExecutableDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve executable path: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe), nil
}

// DefaultConfigPath returns the production config path.
// Priority: 1) %PROGRAMDATA%\OdooPrintAgent\config.yaml on Windows 2) beside exe
// Never depends on process.cwd() (service cwd is System32).
func DefaultConfigPath() string {
	if pd := os.Getenv("PROGRAMDATA"); pd != "" {
		return filepath.Join(pd, "OdooPrintAgent", "config.yaml")
	}
	dir, err := ExecutableDir()
	if err != nil {
		return "config.yaml"
	}
	return filepath.Join(dir, "config.yaml")
}

// LegacyConfigPath is the pre-ProgramData path (beside exe) for migration.
func LegacyConfigPath() string {
	dir, err := ExecutableDir()
	if err != nil {
		return "config.yaml"
	}
	return filepath.Join(dir, "config.yaml")
}

// QueueDBPath returns the local SQLite queue path, stored alongside
// whichever config file was actually loaded (not the cwd).
func QueueDBPath(configPath string) string {
	dir := filepath.Dir(configPath)
	if dir == "" || dir == "." {
		if d, err := ExecutableDir(); err == nil {
			dir = d
		}
	}
	return filepath.Join(dir, "agent.db")
}

// Validate checks required fields: server url, printer configs with IP:port etc.
// It does NOT check secret presence — an unregistered agent has empty id/secret.
func (c *Config) Validate() error {
	if c.Server.URL != "" {
		u, err := url.Parse(c.Server.URL)
		if err != nil {
			return fmt.Errorf("server.url invalid: %w", err)
		}
		if u.Scheme != "https" && u.Scheme != "http" {
			return fmt.Errorf("server.url scheme must be https or http, got %q", u.Scheme)
		}
	}
	for _, p := range c.Printers {
		if err := ValidatePrinterConfig(p); err != nil {
			return err
		}
	}
	return nil
}

var printerIDRe = regexp.MustCompile(`^[a-z0-9_][a-z0-9_-]*$`)

// ValidatePrinterConfig checks a single printer block.
func ValidatePrinterConfig(p PrinterConfig) error {
	if p.ID == "" {
		return fmt.Errorf("printer missing id")
	}
	if !printerIDRe.MatchString(p.ID) {
		return fmt.Errorf("printer %q: id must match %s", p.ID, printerIDRe.String())
	}
	if p.Name == "" {
		return fmt.Errorf("printer %s: name required", p.ID)
	}
	switch p.Type {
	case "network", "usb":
	default:
		return fmt.Errorf("printer %s: type must be network or usb, got %q", p.ID, p.Type)
	}
	switch p.Protocol {
	case "raw", "escpos", "ipp", "":
	default:
		return fmt.Errorf("printer %s: protocol must be raw/escpos/ipp, got %q", p.ID, p.Protocol)
	}
	if p.Type == "network" {
		if p.Endpoint == "" {
			return fmt.Errorf("printer %s: network endpoint required (ip:port)", p.ID)
		}
		host, portStr, err := net.SplitHostPort(p.Endpoint)
		if err != nil {
			return fmt.Errorf("printer %s: endpoint must be ip:port, got %q", p.ID, p.Endpoint)
		}
		if host == "" || net.ParseIP(strings.Trim(host, "[]")) == nil {
			// allow hostname as well, but warn if not IP
			if strings.Contains(host, " ") {
				return fmt.Errorf("printer %s: invalid host %q", p.ID, host)
			}
		}
		port, err := strconv.Atoi(portStr)
		if err != nil || port < 1 || port > 65535 {
			return fmt.Errorf("printer %s: invalid port %q", p.ID, portStr)
		}
	}
	return nil
}
