package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
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
	if path == "" {
		return &Config{}, nil
	}
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

// Ensure creates the config directory and a safe default config file on a
// completely fresh installation. It is idempotent and never overwrites an
// existing file.
func Ensure(path string) error {
	if path == "" {
		return fmt.Errorf("config path is empty")
	}
	dir := filepath.Dir(path)
	if dir == "" {
		dir = "."
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create config dir %s: %w", dir, err)
	}
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("stat %s: %w", path, err)
	}

	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "odoo-print-agent"
	}
	name := "Odoo Print Agent"
	if runtime.GOOS == "windows" {
		name = host
	}
	cfg := &Config{}
	cfg.Agent.Name = name
	if err := cfg.Save(path); err != nil {
		return fmt.Errorf("create default config %s: %w", path, err)
	}
	return nil
}

// Save persists the config atomically: the serialized YAML is written to a
// sibling temp file with 0600 permissions, fsynced, and then renamed over the
// target. A crash mid-write can therefore never leave a truncated config
// (which could strand the pairing secret), and the secret is never
// momentarily world-readable on POSIX filesystems. On Windows the installer
// applies the ProgramData ACLs on top (see INSTALLATION.md).
func (c *Config) Save(path string) error {
	if path == "" {
		return fmt.Errorf("config path is empty")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create config dir %s: %w", dir, err)
	}

	data, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("encode config %s: %w", path, err)
	}

	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("create temp config %s: %w", tmp, err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return fmt.Errorf("write temp config %s: %w", tmp, err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("sync temp config %s: %w", tmp, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close temp config %s: %w", tmp, err)
	}
	// os.Rename on the same volume is atomic; on Windows it replaces an
	// existing destination file (Go >= 1.20 semantics).
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("commit config %s: %w", path, err)
	}
	// Belt-and-braces: re-assert restrictive permissions on the final path
	// (the rename already carries 0600 from the temp file on POSIX).
	_ = os.Chmod(path, 0600)
	return nil
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
// Priority: 1) ODOO_PRINT_AGENT_DATA_DIR override
//           2) %PROGRAMDATA%\OdooPrintAgent\config.yaml on Windows
//           3) beside exe
// Never depends on process.cwd() (service cwd is System32).
func DefaultConfigPath() string {
	if override := os.Getenv("ODOO_PRINT_AGENT_DATA_DIR"); override != "" {
		return filepath.Join(override, "config.yaml")
	}
	if pd := os.Getenv("PROGRAMDATA"); pd != "" {
		return filepath.Join(pd, "OdooPrintAgent", "config.yaml")
	}
	dir, err := ExecutableDir()
	if err != nil {
		return "config.yaml"
	}
	return filepath.Join(dir, "config.yaml")
}

// LocalConfigPath is a per-user fallback when the machine is not being run
// elevated and the installer has not pre-created %PROGRAMDATA%.
func LocalConfigPath() string {
	if override := os.Getenv("ODOO_PRINT_AGENT_DATA_DIR"); override != "" {
		return filepath.Join(override, "config.yaml")
	}
	if la := os.Getenv("LOCALAPPDATA"); la != "" {
		return filepath.Join(la, "OdooPrintAgent", "config.yaml")
	}
	if home := os.Getenv("HOME"); home != "" {
		return filepath.Join(home, ".config", "odoo-print-agent", "config.yaml")
	}
	return DefaultConfigPath()
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

// DefaultLogDir returns the writable log directory beside the config file.
func DefaultLogDir(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "logs")
}

// DefaultLogPath returns the agent's primary log file path.
func DefaultLogPath(configPath string) string {
	return filepath.Join(DefaultLogDir(configPath), "agent.log")
}

// Validate checks required fields: server url, printer configs with IP:port etc.
// A completely unregistered agent (empty id) is valid; once an agent has been
// paired it must also have a reachable server URL and a persisted secret.
func (c *Config) Validate() error {
	if c.Server.URL != "" {
		u, err := url.Parse(c.Server.URL)
		if err != nil {
			return fmt.Errorf("server.url invalid: %w", err)
		}
		if u.Scheme != "https" && u.Scheme != "http" {
			return fmt.Errorf("server.url scheme must be https or http, got %q", u.Scheme)
		}
		if u.Host == "" {
			return fmt.Errorf("server.url host is empty")
		}
	}
	if c.Agent.ID != "" && c.Server.URL == "" {
		return fmt.Errorf("agent.id is set but server.url is empty; re-pair or set server.url")
	}
	if c.Agent.ID != "" && c.Agent.Secret == "" {
		return fmt.Errorf("agent.id is set but agent.secret is empty; re-pair the agent")
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
