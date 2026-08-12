package onboarding

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
)

type Harness struct {
	ID      string
	Name    string
	Channel string
	Command string
}

var harnesses = []Harness{
	{ID: "pi", Name: "Pi", Channel: "native extension", Command: "pi"},
	{ID: "openclaw", Name: "OpenClaw", Channel: "native plugin", Command: "openclaw"},
	{ID: "opencode", Name: "OpenCode", Channel: "native plugin", Command: "opencode"},
	{ID: "claude-code", Name: "Claude Code", Channel: "native plugin", Command: "claude"},
	{ID: "gemini-cli", Name: "Gemini CLI", Channel: "MCP gateway", Command: "gemini"},
	{ID: "goose", Name: "Goose", Channel: "MCP gateway", Command: "goose"},
	{ID: "mcp", Name: "Another MCP harness", Channel: "MCP gateway"},
	{ID: "custom", Name: "Custom hooks or executor", Channel: "HTTP or SDK"},
}

type Detection struct {
	Harness Harness
	Path    string
}

func Detect() []Detection {
	return DetectWith(exec.LookPath)
}

func DetectWith(lookPath func(string) (string, error)) []Detection {
	detected := make([]Detection, 0, len(harnesses))
	for _, harness := range harnesses {
		if harness.Command == "" {
			continue
		}
		path, err := lookPath(harness.Command)
		if err == nil {
			detected = append(detected, Detection{Harness: harness, Path: path})
		}
	}
	return detected
}

func IsDetected(harness Harness, detected []Detection) bool {
	for _, candidate := range detected {
		if candidate.Harness.ID == harness.ID {
			return true
		}
	}
	return false
}

func Harnesses() []Harness {
	result := make([]Harness, len(harnesses))
	copy(result, harnesses)
	return result
}

func Resolve(value string) (Harness, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	aliases := map[string]string{
		"claude": "claude-code", "gemini": "gemini-cli", "other": "mcp",
		"hooks": "custom", "sdk": "custom",
	}
	if alias, ok := aliases[normalized]; ok {
		normalized = alias
	}
	for _, harness := range harnesses {
		if harness.ID == normalized {
			return harness, nil
		}
	}
	return Harness{}, fmt.Errorf("unknown harness %q; run arbiter onboard --list", value)
}

func Prompt(input io.Reader, output io.Writer) (Harness, error) {
	detected := Detect()
	fmt.Fprintln(output, "Welcome to Arbiter. Let's guard your agent's tool calls.")
	fmt.Fprintln(output, "\nWhich harness do you want to use?")
	for index, harness := range harnesses {
		status := ""
		if IsDetected(harness, detected) {
			status = " · detected"
		}
		fmt.Fprintf(output, "  %d) %-27s %s%s\n", index+1, harness.Name, harness.Channel, status)
	}
	fmt.Fprintf(output, "Select a harness [1-%d]: ", len(harnesses))

	scanner := bufio.NewScanner(input)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return Harness{}, fmt.Errorf("read harness selection: %w", err)
		}
		return Harness{}, errors.New("no harness selected; use --harness <name> for non-interactive setup")
	}
	selection := strings.TrimSpace(scanner.Text())
	if number, err := strconv.Atoi(selection); err == nil && number >= 1 && number <= len(harnesses) {
		return harnesses[number-1], nil
	}
	return Resolve(selection)
}

func PrintHarnesses(output io.Writer) {
	for _, harness := range harnesses {
		fmt.Fprintf(output, "%-14s %-27s %s\n", harness.ID, harness.Name, harness.Channel)
	}
}

func VerificationStep(harness Harness) string {
	switch harness.ID {
	case "pi":
		return "start Pi and run /arbiter for a live protected-tool readiness check"
	case "opencode":
		return "start OpenCode and confirm @randromeda/arbiter-opencode loads without a plugin error"
	case "claude-code":
		return "start Claude Code and run /hooks; confirm all three Arbiter hooks have a Plugin source"
	case "openclaw":
		return "restart OpenClaw and confirm the arbiter-openclaw plugin is enabled"
	case "gemini-cli", "goose", "mcp":
		return "check the arbiter-mcp /readyz endpoint, then list tools through the configured MCP connection"
	default:
		return "send one allowed and one denied test call through the final execution boundary"
	}
}

func PrintPlan(output io.Writer, harness Harness, configPath, baseURL string, runtimeStarted bool) {
	fmt.Fprintf(output, "\nArbiter is ready to connect to %s via %s.\n", harness.Name, harness.Channel)
	fmt.Fprintf(output, "Local config: %s\nRuntime URL: %s\n", configPath, baseURL)
	if runtimeStarted {
		fmt.Fprintln(output, "\n1. Arbiter is running and passed its readiness check.")
	} else {
		fmt.Fprintln(output, "\n1. Start Arbiter:")
		fmt.Fprintln(output, "   arbiter local start --background")
	}

	switch harness.ID {
	case "pi":
		fmt.Fprintln(output, "2. Install the native extension from an Arbiter checkout:")
		fmt.Fprintln(output, "   pi install -l ./integrations/pi-extension")
		fmt.Fprintln(output, "3. Start Pi and run /arbiter to check live readiness.")
	case "openclaw":
		fmt.Fprintln(output, "2. Install the native plugin from an Arbiter checkout:")
		fmt.Fprintln(output, "   openclaw plugins install ./integrations/openclaw-plugin")
		fmt.Fprintln(output, "3. Enable arbiter-openclaw in the OpenClaw plugin config and restart OpenClaw.")
	case "opencode":
		fmt.Fprintln(output, "2. For checkout-based setup now, follow integrations/opencode-plugin/README.md.")
		fmt.Fprintln(output, "   After the registry release, add the package to opencode.json:")
		fmt.Fprintln(output, `   "plugin": ["@randromeda/arbiter-opencode"]`)
		fmt.Fprintln(output, "3. Start OpenCode. Set ARBITER_OPENCODE_PROTECT_TOOLS='*' to guard every tool.")
	case "claude-code":
		fmt.Fprintln(output, "2. Add the Arbiter marketplace and install the native plugin:")
		fmt.Fprintln(output, "   claude plugin marketplace add yajasmalhotra/arbiter")
		fmt.Fprintln(output, "   claude plugin install arbiter-guardrails@arbiter")
		fmt.Fprintln(output, "3. Start Claude Code and run /hooks to verify the plugin hooks.")
		fmt.Fprintln(output, "   Set ARBITER_CLAUDE_PROTECT_TOOLS='*' to guard every tool.")
	case "gemini-cli":
		printMCPGateway(output)
		fmt.Fprintln(output, "3. Register the protected MCP server:")
		fmt.Fprintln(output, "   gemini mcp add --transport http arbiter http://127.0.0.1:8090/mcp")
	case "goose":
		printMCPGateway(output)
		fmt.Fprintln(output, "3. Add a remote MCP extension in Goose pointing to http://127.0.0.1:8090/mcp.")
	case "mcp":
		printMCPGateway(output)
		fmt.Fprintln(output, "3. Point the harness's Streamable HTTP MCP config to http://127.0.0.1:8090/mcp.")
	case "custom":
		fmt.Fprintln(output, "2. Wrap the final tool-execution boundary with integrations/python or the HTTP API.")
		fmt.Fprintln(output, "3. Follow docs/integrating-local-harnesses.md and its conformance checklist.")
	}

	if harness.Channel == "MCP gateway" {
		fmt.Fprintln(output, "\nCoverage: this protects the wrapped MCP server, not the harness's built-in shell or file tools.")
	}
}

func printMCPGateway(output io.Writer) {
	fmt.Fprintln(output, "2. Start a gateway for the MCP tool server you want to protect:")
	fmt.Fprintln(output, "   ARBITER_MCP_UPSTREAM_URL=<upstream-mcp-url> arbiter-mcp")
}
