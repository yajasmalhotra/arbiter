package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"arbiter/internal/executorauth"
	"arbiter/internal/interceptor"
	"arbiter/internal/local"
	"arbiter/internal/onboarding"
	"arbiter/internal/telemetry"
)

func main() {
	if len(os.Args) < 2 {
		if err := runOnboard(nil, os.Stdin, os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "arbiter onboarding error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	switch os.Args[1] {
	case "local":
		if err := runLocal(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "arbiter local error: %v\n", err)
			os.Exit(1)
		}
	case "onboard":
		if err := runOnboard(os.Args[2:], os.Stdin, os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "arbiter onboarding error: %v\n", err)
			os.Exit(1)
		}
	default:
		printUsage()
		os.Exit(1)
	}
}

func runOnboard(args []string, input io.Reader, output io.Writer) error {
	flags := flag.NewFlagSet("arbiter onboard", flag.ContinueOnError)
	flags.SetOutput(output)
	harnessName := flags.String("harness", "", "harness to configure (run --list for choices)")
	list := flags.Bool("list", false, "list supported harness paths")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected argument %q", flags.Arg(0))
	}
	if *list {
		onboarding.PrintHarnesses(output)
		return nil
	}

	var (
		harness onboarding.Harness
		err     error
	)
	if *harnessName == "" {
		harness, err = onboarding.Prompt(input, output)
	} else {
		harness, err = onboarding.Resolve(*harnessName)
	}
	if err != nil {
		return err
	}
	result, err := local.EnsureConfig("")
	if err != nil {
		return err
	}
	onboarding.PrintPlan(output, harness, result.Path, result.Config.BaseURL)
	return nil
}

func runLocal(args []string) error {
	if len(args) == 0 {
		printLocalUsage()
		return nil
	}

	switch args[0] {
	case "init":
		result, err := local.EnsureConfig("")
		if err != nil {
			return err
		}
		if result.Created {
			fmt.Printf("Initialized local Arbiter config at %s\n", result.Path)
		} else {
			fmt.Printf("Local Arbiter config already exists at %s\n", result.Path)
		}
		fmt.Printf("Base URL: %s\n", result.Config.BaseURL)
		return nil
	case "start":
		return runLocalStart()
	case "status":
		return runLocalStatus()
	default:
		printLocalUsage()
		return fmt.Errorf("unknown local command %q", args[0])
	}
}

func runLocalStart() error {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	result, err := local.EnsureConfig("")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(result.Config.DataDir, 0o700); err != nil {
		return fmt.Errorf("create local data directory: %w", err)
	}

	store, err := local.OpenStore(result.Config.DBPath)
	if err != nil {
		return err
	}
	defer func() {
		_ = store.Close()
	}()

	decider, err := local.NewDecider(context.Background())
	if err != nil {
		return err
	}

	issuer := executorauth.NewIssuerVerifier(
		[]byte(result.Config.TokenSecret),
		"arbiter-local",
		2*time.Minute,
		store,
	)

	metricsRecorder := telemetry.NewCounterRecorder()

	service := interceptor.NewService(
		interceptor.Config{
			MaxBodyBytes:      1 << 20,
			MaxParameterBytes: 32 << 10,
			DecisionTimeout:   1500 * time.Millisecond,
			StateLookupLimit:  10,
		},
		store,
		decider,
		issuer,
		nil,
		metricsRecorder,
	)

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)
	mux.HandleFunc("GET /metrics", metricsRecorder.Handler())

	server := &http.Server{
		Addr:              result.Config.Address,
		Handler:           telemetry.WithTrace(mux),
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	logger.Info("starting local arbiter runtime", "addr", result.Config.Address, "config", result.Path)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func runLocalStatus() error {
	result, err := local.LoadConfig("")
	if err != nil {
		return fmt.Errorf("load local config: %w", err)
	}

	client := http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(result.Config.BaseURL + "/healthz")
	if err != nil {
		return fmt.Errorf("local runtime not reachable at %s: %w", result.Config.BaseURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("local runtime unhealthy at %s (status %d)", result.Config.BaseURL, resp.StatusCode)
	}

	fmt.Printf("Local runtime is running at %s\n", result.Config.BaseURL)
	return nil
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "Usage: arbiter <command>")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Commands:")
	fmt.Fprintln(os.Stderr, "  onboard [--harness <name>]")
	fmt.Fprintln(os.Stderr, "  local init")
	fmt.Fprintln(os.Stderr, "  local start")
	fmt.Fprintln(os.Stderr, "  local status")
}

func printLocalUsage() {
	fmt.Fprintln(os.Stderr, "Usage: arbiter local <init|start|status>")
}
