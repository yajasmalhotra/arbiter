package onboarding

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestPromptAcceptsNumbersNamesAndAliases(t *testing.T) {
	t.Parallel()
	for _, testCase := range []struct{ input, want string }{
		{input: "1\n", want: "pi"},
		{input: "OpenCode\n", want: "opencode"},
		{input: "gemini\n", want: "gemini-cli"},
	} {
		var output bytes.Buffer
		harness, err := Prompt(strings.NewReader(testCase.input), &output)
		if err != nil {
			t.Fatalf("prompt %q: %v", testCase.input, err)
		}
		if harness.ID != testCase.want {
			t.Fatalf("prompt %q selected %q, want %q", testCase.input, harness.ID, testCase.want)
		}
		if !strings.Contains(output.String(), "Which harness") {
			t.Fatal("prompt did not ask for a harness")
		}
	}
}

func TestDetectReportsOnlyInstalledHarnesses(t *testing.T) {
	t.Parallel()
	detected := DetectWith(func(command string) (string, error) {
		if command == "pi" || command == "opencode" {
			return "/tools/" + command, nil
		}
		return "", errors.New("not found")
	})
	if len(detected) != 2 {
		t.Fatalf("detected %d harnesses, want 2", len(detected))
	}
	if detected[0].Harness.ID != "pi" || detected[1].Harness.ID != "opencode" {
		t.Fatalf("unexpected detections: %#v", detected)
	}
}

func TestPromptRejectsMissingAndUnknownSelections(t *testing.T) {
	t.Parallel()
	for _, input := range []string{"", "not-a-harness\n"} {
		if _, err := Prompt(strings.NewReader(input), &bytes.Buffer{}); err == nil {
			t.Fatalf("expected input %q to fail", input)
		}
	}
}

func TestPlansDistinguishNativeAndMCPProtection(t *testing.T) {
	t.Parallel()
	opencode, _ := Resolve("opencode")
	var native bytes.Buffer
	PrintPlan(&native, opencode, "/tmp/config.json", "http://127.0.0.1:8080", false)
	if !strings.Contains(native.String(), "@randromeda/arbiter-opencode") {
		t.Fatalf("OpenCode plan is missing the native package: %s", native.String())
	}
	if strings.Contains(native.String(), "opencode plugin ") {
		t.Fatal("OpenCode plan includes a nonexistent plugin installation command")
	}
	if strings.Contains(native.String(), "not the harness's built-in") {
		t.Fatal("native OpenCode plan included the MCP-only warning")
	}

	claude, _ := Resolve("claude")
	var claudeNative bytes.Buffer
	PrintPlan(&claudeNative, claude, "/tmp/config.json", "http://127.0.0.1:8080", false)
	for _, expected := range []string{"native plugin", "claude plugin marketplace add", "arbiter-guardrails@arbiter", "ARBITER_CLAUDE_PROTECT_TOOLS='*'"} {
		if !strings.Contains(claudeNative.String(), expected) {
			t.Fatalf("Claude plan is missing %q: %s", expected, claudeNative.String())
		}
	}
	if strings.Contains(claudeNative.String(), "not the harness's built-in") {
		t.Fatal("native Claude plan included the MCP-only coverage warning")
	}
}

func TestVerificationStepsAreHarnessNative(t *testing.T) {
	t.Parallel()
	for id, expected := range map[string]string{
		"pi":          "/arbiter",
		"opencode":    "@randromeda/arbiter-opencode",
		"claude-code": "/hooks",
	} {
		harness, err := Resolve(id)
		if err != nil {
			t.Fatal(err)
		}
		if step := VerificationStep(harness); !strings.Contains(step, expected) {
			t.Fatalf("%s verification step %q is missing %q", id, step, expected)
		}
	}
}

func TestHarnessListCoversNativeMCPAndCustomPaths(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	PrintHarnesses(&output)
	for _, expected := range []string{"pi", "openclaw", "opencode", "claude-code", "gemini-cli", "goose", "mcp", "custom"} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("harness list is missing %q", expected)
		}
	}
}
