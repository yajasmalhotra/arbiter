# Arbiter for Claude Code

Native Claude Code plugin that enforces Arbiter policy before built-in, custom,
and MCP tools execute. It uses `PreToolUse`, `PostToolUse`, and
`PostToolUseFailure` command hooks and has no runtime package dependencies.

## Install from this repository

For one session:

```bash
claude --plugin-dir ./integrations/claude-code-plugin
```

For a persistent installation through the Arbiter marketplace:

```bash
claude plugin marketplace add yajasmalhotra/arbiter
claude plugin install arbiter-guardrails@arbiter
```

Start Arbiter first. The plugin discovers `~/.arbiter/config.json`, so local
use requires no copied URL, tenant, or secret:

```bash
arbiter local start
claude
```

Run `/hooks` in Claude Code and confirm the Arbiter `PreToolUse`, `PostToolUse`,
and `PostToolUseFailure` hooks are listed with a Plugin source.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARBITER_CLAUDE_URL` | local runtime config | Arbiter base URL |
| `ARBITER_CLAUDE_TENANT_ID` | local runtime config | Tenant bound into decisions |
| `ARBITER_CLAUDE_ACTOR_ID` | `claude-code-agent` | Stable policy and audit actor |
| `ARBITER_CLAUDE_PROTECT_TOOLS` | `Bash,PowerShell,Write,Edit,NotebookEdit` | Comma-separated tools; use `*` for every tool |
| `ARBITER_CLAUDE_FAIL_CLOSED` | `true` | Deny on configuration, transport, or state failures |
| `ARBITER_CLAUDE_RECORD_STATE` | `true` | Record verified success and failure outcomes |
| `ARBITER_CLAUDE_TIMEOUT_MS` | `5000` | Per-request timeout, bounded to 250–25000 ms |
| `ARBITER_CLAUDE_BEARER_TOKEN` | unset | Authenticated workload bearer token |
| `ARBITER_GATEWAY_SHARED_KEY` | unset | Development/legacy interceptor boundary key |
| `ARBITER_SERVICE_SHARED_KEY` | unset | Verify and state endpoint boundary key |

Shared `ARBITER_URL`, `ARBITER_TENANT_ID`, `ARBITER_ACTOR_ID`, and
`ARBITER_WORKLOAD_TOKEN` aliases are supported. Claude-specific values take
precedence.

An Arbiter allow does not bypass Claude Code's own permission system: the hook
stays silent and normal permission evaluation continues. An Arbiter denial is
returned as a structured `permissionDecision: "deny"` before execution.

For enterprise deployments, use `ARBITER_CLAUDE_PROTECT_TOOLS='*'`, distribute
the marketplace and plugin through managed settings, and use authenticated
workload identity. Like every in-process hook, the plugin is not a substitute
for least-privilege credentials or an isolated executor.
