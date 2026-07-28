package mcp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
)

// StdioTransport maintains one line-delimited JSON-RPC connection to a local
// MCP server process. Calls are serialized so request/response pairing remains
// deterministic even when the server does not include response IDs in every
// notification.
type StdioTransport struct {
	command *exec.Cmd
	stdin   io.WriteCloser
	stdout  *bufio.Reader
	mu      sync.Mutex
}

func NewStdioTransport(ctx context.Context, command string, args ...string) (*StdioTransport, error) {
	if command == "" {
		return nil, errors.New("stdio MCP command is required")
	}
	cmd := exec.CommandContext(ctx, command, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("create MCP stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("create MCP stdout: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start MCP server: %w", err)
	}
	return &StdioTransport{command: cmd, stdin: stdin, stdout: bufio.NewReader(stdout)}, nil
}

func (t *StdioTransport) RoundTrip(ctx context.Context, body []byte) ([]byte, int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, 504, err
	}
	if _, err := t.stdin.Write(append(append([]byte(nil), body...), '\n')); err != nil {
		return nil, 502, fmt.Errorf("write MCP request: %w", err)
	}
	response, err := t.stdout.ReadBytes('\n')
	if err != nil {
		return nil, 502, fmt.Errorf("read MCP response: %w", err)
	}
	return response, 200, nil
}

func (t *StdioTransport) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stdin != nil {
		_ = t.stdin.Close()
	}
	if t.command != nil && t.command.Process != nil {
		return t.command.Process.Kill()
	}
	return nil
}
