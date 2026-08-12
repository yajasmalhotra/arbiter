package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunOnboardListsHarnessesWithoutInitializing(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	if err := runOnboard([]string{"--list"}, strings.NewReader(""), &output); err != nil {
		t.Fatalf("list harnesses: %v", err)
	}
	for _, expected := range []string{"pi", "openclaw", "opencode", "custom"} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("list output is missing %q", expected)
		}
	}
}

func TestRunOnboardHelpSucceedsWithoutInitializing(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	if err := runOnboard([]string{"--help"}, strings.NewReader(""), &output); err != nil {
		t.Fatalf("show help: %v", err)
	}
	if !strings.Contains(output.String(), "harness string") {
		t.Fatalf("help output is missing the harness option: %s", output.String())
	}
	if !strings.Contains(output.String(), "no-start") {
		t.Fatalf("help output is missing the runtime opt-out: %s", output.String())
	}
}

func TestRunDoctorHelpSucceedsWithoutReadingConfig(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	if err := runDoctor([]string{"--help"}, &output); err != nil {
		t.Fatalf("show doctor help: %v", err)
	}
	if !strings.Contains(output.String(), "harness string") {
		t.Fatalf("doctor help is missing the harness option: %s", output.String())
	}
}
