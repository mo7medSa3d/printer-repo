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
		PDFPrintCommand []string `yaml:"pdf_print_command,omitempty"`
		ReprintAfterCrash *bool `yaml:"reprint_after_crash,omitempty"`
	} `yaml:"agent"`
	Printers []PrinterConfig `yaml:"printers"`
}

type PrinterConfig struct {
	ID             string                 `yaml:"id"`
	Name           string                 `yaml:"name"`
	Type           string                 `yaml:"type"`
	Endpoint       string                 `yaml:"endpoint"`
	Protocol       string                 `yaml:"protocol"`
	SpoolerName    string                 `yaml:"spooler_name,omitempty"`
	ConnectionType string                 `yaml:"connection_type,omitempty"`
	PrinterType    string                 `yaml:"printer_type,omitempty"`
	USBVID         string                 `yaml:"usb_vid,omitempty"`
	USBPID         string                 `yaml:"usb_pid,omitempty"`
	USBSerial      string                 `yaml:"usb_serial,omitempty"`
	Capabilities   map[string]interface{} `yaml:"capabilities,omitempty"`
	Enabled        *bool                  `yaml:"enabled,omitempty"`
}

func (c *Config) ReprintAfterCrashEnabled() bool {
	// Safe default: physical output after a crash is unknown. Operators must
	// explicitly opt into at-least-once reprinting (and accept duplicates) by
	// setting agent.reprint_after_crash: true.
	if c == nil || c.Agent.ReprintAfterCrash == nil {
		return false
	}
	return *c.Agent.ReprintAfterCrash
}

func allowInsecureHTTP() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("ODOO_PRINT_AGENT_ENV")), "development") &&
		os.Getenv("ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP") == "1"
}

func validateServerURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("server.url invalid: %w", err)
	}
	if u.Host == "" {
		return fmt.Errorf("server.url host is empty")
	}
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme == "http" && allowInsecureHTTP() {
		return nil
	}
	if u.Scheme == "http" {
		return fmt.Errorf("server.url must use https; insecure http is allowed only when ODOO_PRINT_AGENT_ENV=development and ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP=1")
	}
	return fmt.Errorf("server.url scheme must be https, got %q", u.Scheme)
}

func defaultConfig() *Config {
	cfg := &Config{}
	cfg.Agent.ReprintAfterCrash = boolPtr(false)
	return cfg
}

func boolPtr(v bool) *bool { return &v }

func Load(path string) (*Config, error) {
	if path == "" {
		return defaultConfig(), nil
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return defaultConfig(), nil
		}
		return nil, err
	}
	defer f.Close()

	cfg := defaultConfig()
	err = yaml.NewDecoder(f).Decode(cfg)
	if err != nil {
		return nil, err
	}
	if cfg.Agent.ReprintAfterCrash == nil {
		cfg.Agent.ReprintAfterCrash = boolPtr(false)
	}
	return cfg, nil
}

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
	cfg := defaultConfig()
	cfg.Agent.Name = name
	if err := cfg.Save(path); err != nil {
		return fmt.Errorf("create default config %s: %w", path, err)
	}
	return nil
}

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
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("commit config %s: %w", path, err)
	}
	_ = os.Chmod(path, 0600)
	return nil
}

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

func LegacyConfigPath() string {
	dir, err := ExecutableDir()
	if err != nil {
		return "config.yaml"
	}
	return filepath.Join(dir, "config.yaml")
}

func QueueDBPath(configPath string) string {
	dir := filepath.Dir(configPath)
	if dir == "" || dir == "." {
		if d, err := ExecutableDir(); err == nil {
			dir = d
		}
	}
	return filepath.Join(dir, "agent.db")
}

func DefaultLogDir(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "logs")
}

func DefaultLogPath(configPath string) string {
	return filepath.Join(DefaultLogDir(configPath), "agent.log")
}

func (c *Config) Validate() error {
	if c.Server.URL != "" {
		if err := validateServerURL(c.Server.URL); err != nil {
			return err
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

func (p PrinterConfig) NormalizedType() string {
	t := p.ConnectionType
	if t == "" {
		t = p.Type
	}
	t = strings.ToLower(strings.TrimSpace(t))
	switch t {
	case "tcp":
		return "network"
	case "":
		return "network"
	default:
		return t
	}
}

func (p PrinterConfig) NormalizedProtocol() string {
	proto := strings.ToLower(strings.TrimSpace(p.Protocol))
	if proto == "" {
		return "raw"
	}
	if proto == "windows_spooler" {
		return "spooler"
	}
	return proto
}

func (p PrinterConfig) IsEnabled() bool {
	if p.Enabled != nil {
		return *p.Enabled
	}
	return true
}

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
	nt := p.NormalizedType()
	switch nt {
	case "network", "usb", "spooler", "ipp", "ipps":
	default:
		return fmt.Errorf("printer %s: type must be network/usb/spooler/ipp/ipps, got %q", p.ID, p.Type)
	}
	proto := p.NormalizedProtocol()
	switch proto {
	case "raw", "escpos", "ipp", "ipps", "spooler", "":
	default:
		return fmt.Errorf("printer %s: protocol must be raw/escpos/ipp/ipps/spooler, got %q", p.ID, p.Protocol)
	}
	if nt == "network" || nt == "ipp" || nt == "ipps" {
		ep := p.Endpoint
		if nt == "ipp" && ep == "" {
			return nil
		}
		if ep == "" {
			return fmt.Errorf("printer %s: network endpoint required (ip:port)", p.ID)
		}
		if strings.HasPrefix(proto, "ipp") || strings.HasPrefix(ep, "ipp://") || strings.HasPrefix(ep, "http") {
			return nil
		}
		host, portStr, err := net.SplitHostPort(ep)
		if err != nil {
			return fmt.Errorf("printer %s: endpoint must be ip:port, got %q", p.ID, p.Endpoint)
		}
		if host == "" || net.ParseIP(strings.Trim(host, "[]")) == nil {
			if strings.Contains(host, " ") {
				return fmt.Errorf("printer %s: invalid host %q", p.ID, host)
			}
		}
		port, err := strconv.Atoi(portStr)
		if err != nil || port < 1 || port > 65535 {
			return fmt.Errorf("printer %s: invalid port %q", p.ID, portStr)
		}
	}
	if nt == "spooler" {
		if p.SpoolerName == "" && p.Endpoint == "" {
			return fmt.Errorf("printer %s: spooler printer requires spooler_name or endpoint", p.ID)
		}
	}
	return nil
}

func RegistryPath(configPath string) string {
	dir := filepath.Dir(configPath)
	if dir == "" || dir == "." {
		if d, err := ExecutableDir(); err == nil {
			dir = d
		}
	}
	return filepath.Join(dir, "printers.json")
}
