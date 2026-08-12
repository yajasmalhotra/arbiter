# Integrating Local Agent Harnesses

Run `arbiter` with no arguments for guided setup, or use
`arbiter onboard --harness <name>`. Run `arbiter onboard --list` to see the
native, MCP, and custom paths. Guided setup detects harness CLIs, starts the
local runtime in the background, waits for `/readyz`, and prints the correct
harness-native installation path. Use `--no-start` to leave runtime lifecycle
to another process manager.

Use the narrowest integration that can keep Arbiter on the execution path. A
harness integration should translate lifecycle events; it should not reimplement
policy, permit validation, or state semantics.

## Choose an integration path

| Harness capability | Recommended path | Harness changes |
| --- | --- | --- |
| Uses MCP tools | Put `arbiter-mcp` in front of the MCP server | Change the MCP server URL or command |
| Has before/after tool hooks | Build a thin native adapter | Register one pre-call and one post-result hook |
| Owns a custom tool executor | Use the Go or Python integration APIs | Wrap the executor at its final side-effect boundary |

Prefer the MCP gateway when it fits. It provides execution-time permit
consumption outside the agent process, so disabling a harness extension does
not silently bypass enforcement. Native hooks offer the best installation and
feedback experience for built-in harness tools, but the underlying tool
credentials should still be scoped as narrowly as possible.

The Pi extension in `integrations/pi-extension` is the reference native
adapter. The OpenClaw, OpenCode, and Claude Code plugins demonstrate the same
contract with different hook APIs.

## Native adapter contract

A native adapter needs only this lifecycle:

1. Capture the exact tool name and arguments in the harness's pre-execution
   hook.
2. Build a canonical Arbiter request with stable tenant, actor, session, and
   call identifiers.
3. Call intercept and block the tool unless Arbiter returns an allow decision.
4. Verify and consume the returned permit before allowing execution. Fail
   closed by default on denial, timeout, malformed response, or unavailable
   dependencies.
5. In the post-result hook, record state only when the corresponding call was
   both verified and executed. Never record denied or merely proposed calls.

Protect all tools in enterprise deployments. A smaller default set of
side-effecting tools can make a local evaluation less noisy, but custom tools
must not become an accidental bypass.

## Shared configuration

Adapters should accept these common variables so one local or enterprise
environment can configure several harnesses:

| Variable | Meaning |
| --- | --- |
| `ARBITER_URL` | Arbiter runtime base URL |
| `ARBITER_TENANT_ID` | Tenant used for policy and audit isolation |
| `ARBITER_ACTOR_ID` | Stable agent or workload actor identifier |
| `ARBITER_WORKLOAD_TOKEN` | Authenticated workload bearer token |

A harness may add prefixed overrides, such as `ARBITER_PI_URL`, for users who
run multiple differently scoped adapters. Prefixed values should take
precedence over shared values. Local adapters should also discover
`~/.arbiter/config.json`, which lets this work without copied endpoints:

```bash
go run ./cmd/arbiter local init
go run ./cmd/arbiter local start
```

With an installed binary, `arbiter local start --background`, `arbiter local
status`, and `arbiter local stop` provide a complete local lifecycle. Run
`arbiter doctor --harness <name>` to verify runtime readiness, configuration,
harness discovery, and print the harness-native adapter verification step. Use
`ARBITER_LOCAL_CONFIG` when a development environment needs an isolated config
and data directory.

Secrets must not be printed by status commands or error messages. Production
deployments should use authenticated workload identity and preserve the
gateway and service trust boundaries documented by Arbiter, rather than
depending on local shared-key defaults.

## Installation and diagnostics standard

For a first-class harness integration:

- publish it through the harness's native package mechanism;
- make local Arbiter discovery the zero-configuration default;
- keep runtime dependencies at zero when the platform already provides HTTP;
- provide a harness-native `arbiter` status or doctor command that checks
  configuration and the live `/readyz` endpoint;
- fail startup or protected calls with an actionable message naming missing
  non-secret configuration;
- document both a repository checkout command and the eventual registry
  install command;
- version and test the adapter independently from the Arbiter server.

## Conformance checklist

Every adapter should test these observable guarantees:

- a policy denial prevents the underlying tool from running;
- an allow requires successful permit verification;
- transport errors fail closed unless an explicit development-only fail-open
  option is enabled;
- unprotected reads behave as documented;
- wildcard protection covers built-in and custom tools;
- post-call state is recorded only for executed, verified calls;
- shared configuration and harness-specific precedence are deterministic;
- status diagnostics check live readiness without exposing credentials;
- the package loads in a real supported harness version, not only in mocks.

These tests are the compatibility boundary. Harness-specific UI, command, and
packaging code can evolve without changing Arbiter's enforcement semantics.
