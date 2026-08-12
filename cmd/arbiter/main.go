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
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
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
	case "doctor":
		if err := runDoctor(os.Args[2:], os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "arbiter doctor error: %v\n", err)
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
	noStart := flags.Bool("no-start", false, "initialize configuration without starting the local runtime")
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
	if !*noStart {
		executable, err := os.Executable()
		if err != nil {
			return fmt.Errorf("resolve arbiter executable: %w", err)
		}
		process, err := local.StartBackground(context.Background(), result.Config, executable)
		if err != nil {
			return err
		}
		if process.AlreadyRunning {
			fmt.Fprintf(output, "\n✓ Arbiter is already ready at %s\n", result.Config.BaseURL)
		} else {
			fmt.Fprintf(output, "\n✓ Arbiter started in the background at %s (PID %d)\n", result.Config.BaseURL, process.PID)
			fmt.Fprintf(output, "  Logs: %s\n", process.LogPath)
		}
	}
	if harness.Command != "" {
		if path, err := exec.LookPath(harness.Command); err == nil {
			fmt.Fprintf(output, "✓ %s detected at %s\n", harness.Name, path)
		} else {
			fmt.Fprintf(output, "! %s is not on PATH; install it before completing step 2.\n", harness.Name)
		}
	}
	onboarding.PrintPlan(output, harness, result.Path, result.Config.BaseURL, !*noStart)
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
		flags := flag.NewFlagSet("arbiter local start", flag.ContinueOnError)
		background := flags.Bool("background", false, "start the local runtime in the background")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return fmt.Errorf("unexpected argument %q", flags.Arg(0))
		}
		if *background {
			result, err := local.EnsureConfig("")
			if err != nil {
				return err
			}
			executable, err := os.Executable()
			if err != nil {
				return err
			}
			process, err := local.StartBackground(context.Background(), result.Config, executable)
			if err != nil {
				return err
			}
			if process.AlreadyRunning {
				fmt.Printf("Local runtime is already running at %s\n", result.Config.BaseURL)
			} else {
				fmt.Printf("Started local runtime at %s (PID %d)\nLogs: %s\n", result.Config.BaseURL, process.PID, process.LogPath)
			}
			return nil
		}
		return runLocalStart()
	case "stop":
		result, err := local.LoadConfig("")
		if err != nil {
			return err
		}
		if err := local.StopBackground(context.Background(), result.Config); err != nil {
			return err
		}
		fmt.Println("Stopped local Arbiter runtime")
		return nil
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
	if err := local.CheckReady(context.Background(), result.Config); err == nil {
		return fmt.Errorf("local runtime is already ready at %s", result.Config.BaseURL)
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
	shutdownRequested := make(chan struct{}, 1)
	runtimeState, err := local.CreateRuntimeState(result.Config)
	if err != nil {
		return err
	}
	defer local.RemoveRuntimeState(result.Config)
	local.RegisterStopRoute(mux, runtimeState, func() {
		select {
		case shutdownRequested <- struct{}{}:
		default:
		}
	})

	server := &http.Server{
		Addr:              result.Config.Address,
		Handler:           telemetry.WithTrace(mux),
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	logger.Info("starting local arbiter runtime", "addr", result.Config.Address, "config", result.Path)
	runContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serverError := make(chan error, 1)
	go func() {
		serverError <- server.ListenAndServe()
	}()
	select {
	case err := <-serverError:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-runContext.Done():
	case <-shutdownRequested:
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return server.Shutdown(shutdownContext)
}

func runLocalStatus() error {
	result, err := local.LoadConfig("")
	if err != nil {
		return fmt.Errorf("load local config: %w", err)
	}

	if err := local.CheckReady(context.Background(), result.Config); err != nil {
		return fmt.Errorf("local runtime not reachable at %s: %w", result.Config.BaseURL, err)
	}

	pid, _ := local.RuntimePID(result.Config)
	if pid > 0 {
		fmt.Printf("Local runtime is ready at %s (PID %d)\n", result.Config.BaseURL, pid)
	} else {
		fmt.Printf("Local runtime is ready at %s\n", result.Config.BaseURL)
	}
	return nil
}

func runDoctor(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("arbiter doctor", flag.ContinueOnError)
	flags.SetOutput(output)
	harnessName := flags.String("harness", "", "harness to verify")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected argument %q", flags.Arg(0))
	}
	result, err := local.LoadConfig("")
	if err != nil {
		return fmt.Errorf("load local config: %w", err)
	}
	if err := local.CheckReady(context.Background(), result.Config); err != nil {
		return fmt.Errorf("runtime is not ready at %s: %w", result.Config.BaseURL, err)
	}
	fmt.Fprintf(output, "✓ Runtime ready: %s\n", result.Config.BaseURL)
	fmt.Fprintf(output, "✓ Local config: %s\n", result.Path)

	if strings.TrimSpace(*harnessName) == "" {
		detected := onboarding.Detect()
		if len(detected) == 0 {
			fmt.Fprintln(output, "! No supported harness CLI was detected on PATH.")
			return nil
		}
		for _, detection := range detected {
			fmt.Fprintf(output, "✓ %s detected: %s\n", detection.Harness.Name, detection.Path)
		}
		fmt.Fprintln(output, "Run arbiter doctor --harness <name> for adapter verification guidance.")
		return nil
	}

	harness, err := onboarding.Resolve(*harnessName)
	if err != nil {
		return err
	}
	if harness.Command != "" {
		path, err := exec.LookPath(harness.Command)
		if err != nil {
			return fmt.Errorf("%s CLI %q is not on PATH", harness.Name, harness.Command)
		}
		fmt.Fprintf(output, "✓ %s detected: %s\n", harness.Name, path)
	}
	fmt.Fprintf(output, "Next adapter check: %s\n", onboarding.VerificationStep(harness))
	return nil
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "Usage: arbiter <command>")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Commands:")
	fmt.Fprintln(os.Stderr, "  onboard [--harness <name>]")
	fmt.Fprintln(os.Stderr, "  doctor [--harness <name>]")
	fmt.Fprintln(os.Stderr, "  local init")
	fmt.Fprintln(os.Stderr, "  local start [--background]")
	fmt.Fprintln(os.Stderr, "  local stop")
	fmt.Fprintln(os.Stderr, "  local status")
}

func printLocalUsage() {
	fmt.Fprintln(os.Stderr, "Usage: arbiter local <init|start|stop|status>")
}
