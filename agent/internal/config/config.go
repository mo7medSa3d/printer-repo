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

	"github.com/odoo-print-agent/agent/internal/storage"
)

// secretStoreKey is the key under which the agent's gateway credential is
// sealed in the platform secret store (DPAPI on Windows, owner-only file
// elsewhere). The secret must NOT live in plaintext YAML: on Windows the
// ProgramData config is not an acceptable place for the gateway credential.
const secretStoreKey = "agent_secret"

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
	// A missing/zero-value policy is unsafe if it enables a second physical
	// print after an interrupted side effect. Treat nil as the documented safe
	// default; production config loading also materializes false explicitly.
	return c != nil && c.Agent.ReprintAfterCrash != nil && *c.Agent.ReprintAfterCrash
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

	cfg := defaultConfig()
	decodeErr := yaml.NewDecoder(f).Decode(cfg)
	closeErr := f.Close()
	if decodeErr != nil {
		return nil, decodeErr
	}
	if closeErr != nil {
		return nil, fmt.Errorf("close config %s: %w", path, closeErr)
	}
	if cfg.Agent.ReprintAfterCrash == nil {
		cfg.Agent.ReprintAfterCrash = boolPtr(false)
	}

	dir := filepath.Dir(path)
	if dir == "" || dir == "." {
		if d, err := ExecutableDir(); err == nil {
			dir = d
		}
	}
	store := storage.NewStore(dir)
	if sealed, serr := store.GetSecret(secretStoreKey); serr == nil && sealed != "" {
		cfg.Agent.Secret = sealed
	} else if cfg.Agent.Secret != "" {
		legacySecret := cfg.Agent.Secret
		if merr := store.SaveSecret(secretStoreKey, legacySecret); merr != nil {
			return nil, fmt.Errorf("migrate legacy agent secret to secure storage: %w", merr)
		}
		stripped := *cfg
		stripped.Agent.Secret = ""
		if serr := stripped.Save(path); serr != nil {
			return nil, fmt.Errorf("remove legacy plaintext agent secret from config: %w", serr)
		}
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
	if dir == "" || dir == "." {
		if d, err := ExecutableDir(); err == nil {
			dir = d
		}
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create config dir %s: %w", dir, err)
	}

	toSave := *c
	if c.Agent.Secret != "" {
		if err := storage.NewStore(dir).SaveSecret(secretStoreKey, c.Agent.Secret); err != nil {
			return fmt.Errorf("seal agent secret: %w", err)
		}
		toSave.Agent.Secret = ""
	}

	data, err := yaml.Marshal(&toSave)
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
	if err := replaceFile(tmp, path); err != nil {
		_ = os.Remove(tmp)
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