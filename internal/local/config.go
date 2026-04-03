package local

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultAddress  = "127.0.0.1:8080"
	defaultTenantID = "tenant-local"
	configVersion   = 1
)

type Config struct {
	Version     int    `json:"version"`
	Address     string `json:"address"`
	BaseURL     string `json:"base_url"`
	TenantID    string `json:"tenant_id"`
	DataDir     string `json:"data_dir"`
	DBPath      string `json:"db_path"`
	TokenSecret string `json:"token_secret"`
}

type ConfigLoadResult struct {
	Config  Config
	Path    string
	Created bool
}

func DefaultConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home: %w", err)
	}
	return filepath.Join(home, ".arbiter", "config.json"), nil
}

func LoadConfig(path string) (ConfigLoadResult, error) {
	if path == "" {
		var err error
		path, err = DefaultConfigPath()
		if err != nil {
			return ConfigLoadResult{}, err
		}
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return ConfigLoadResult{}, err
	}

	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return ConfigLoadResult{}, fmt.Errorf("decode local config %s: %w", path, err)
	}
	cfg.applyDefaults(path)
	if err := cfg.validate(); err != nil {
		return ConfigLoadResult{}, err
	}

	return ConfigLoadResult{Config: cfg, Path: path, Created: false}, nil
}

func EnsureConfig(path string) (ConfigLoadResult, error) {
	result, err := LoadConfig(path)
	if err == nil {
		return result, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return ConfigLoadResult{}, err
	}

	if path == "" {
		path, err = DefaultConfigPath()
		if err != nil {
			return ConfigLoadResult{}, err
		}
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return ConfigLoadResult{}, fmt.Errorf("create config directory: %w", err)
	}

	tokenSecret, err := randomSecret()
	if err != nil {
		return ConfigLoadResult{}, err
	}

	cfg := Config{
		Version:     configVersion,
		Address:     defaultAddress,
		BaseURL:     "http://" + defaultAddress,
		TenantID:    defaultTenantID,
		DataDir:     filepath.Join(filepath.Dir(path), "data"),
		TokenSecret: tokenSecret,
	}
	cfg.DBPath = filepath.Join(cfg.DataDir, "arbiter-local.db")
	if err := cfg.validate(); err != nil {
		return ConfigLoadResult{}, err
	}

	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return ConfigLoadResult{}, fmt.Errorf("create data directory: %w", err)
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return ConfigLoadResult{}, fmt.Errorf("encode local config: %w", err)
	}
	raw = append(raw, '\n')
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return ConfigLoadResult{}, fmt.Errorf("write local config: %w", err)
	}

	return ConfigLoadResult{Config: cfg, Path: path, Created: true}, nil
}

func (c *Config) applyDefaults(configPath string) {
	if c.Version == 0 {
		c.Version = configVersion
	}
	c.Address = strings.TrimSpace(c.Address)
	if c.Address == "" {
		c.Address = defaultAddress
	}
	c.BaseURL = strings.TrimSpace(c.BaseURL)
	if c.BaseURL == "" {
		c.BaseURL = "http://" + c.Address
	}
	c.TenantID = strings.TrimSpace(c.TenantID)
	if c.TenantID == "" {
		c.TenantID = defaultTenantID
	}
	c.DataDir = strings.TrimSpace(c.DataDir)
	if c.DataDir == "" {
		c.DataDir = filepath.Join(filepath.Dir(configPath), "data")
	}
	c.DBPath = strings.TrimSpace(c.DBPath)
	if c.DBPath == "" {
		c.DBPath = filepath.Join(c.DataDir, "arbiter-local.db")
	}
}

func (c Config) validate() error {
	if c.Address == "" {
		return errors.New("local config is missing address")
	}
	if c.BaseURL == "" {
		return errors.New("local config is missing base_url")
	}
	if c.DataDir == "" {
		return errors.New("local config is missing data_dir")
	}
	if c.DBPath == "" {
		return errors.New("local config is missing db_path")
	}
	if strings.TrimSpace(c.TokenSecret) == "" {
		return errors.New("local config is missing token_secret")
	}
	if c.TenantID == "" {
		return errors.New("local config is missing tenant_id")
	}
	return nil
}

func randomSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate token secret: %w", err)
	}
	return hex.EncodeToString(buf), nil
}
