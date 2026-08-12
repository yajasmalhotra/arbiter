# Arbiter for Pi

Native [Pi](https://github.com/badlogic/pi-mono) extension that enforces Arbiter policy before Pi executes tools.

The extension intercepts Pi's `tool_call` lifecycle event, sends the exact tool name and arguments to Arbiter, consumes the returned single-use execution permit, and blocks Pi unless both checks pass. After a verified tool runs, `tool_result` records its outcome for sequence-aware policy.

## Install

From this repository:

```bash
pi -e ./integrations/pi-extension
```

For a persistent project-local install:

```bash
pi install -l ./integrations/pi-extension
```

After the npm package is published:

```bash
pi install npm:@randromeda/arbiter-pi
```

Start Arbiter first. The extension automatically reads `~/.arbiter/config.json`, so the local runtime needs no additional URL or tenant configuration:

```bash
go run ./cmd/arbiter local init
go run ./cmd/arbiter local start
pi -e ./integrations/pi-extension
```

Run `/arbiter` inside Pi to see the active endpoint, tenant, actor, and protected tools and perform a live Arbiter readiness check.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ARBITER_PI_URL` | local runtime config | Arbiter base URL |
| `ARBITER_PI_TENANT_ID` | local runtime config | Tenant bound into decisions |
| `ARBITER_PI_ACTOR_ID` | `pi-agent` | Stable agent identity for policy and audit |
| `ARBITER_PI_PROTECT_TOOLS` | `bash,edit,write` | Comma-separated Pi tools; use `*` to protect every tool |
| `ARBITER_PI_FAIL_CLOSED` | `true` | Block on configuration, timeout, or transport failure |
| `ARBITER_PI_RECORD_STATE` | `true` | Record verified tool outcomes for temporal policy |
| `ARBITER_PI_TIMEOUT_MS` | `5000` | Per-request timeout, bounded to 250–60000 ms |
| `ARBITER_PI_BEARER_TOKEN` | unset | Short-lived workload JWT sent to the interceptor |
| `ARBITER_GATEWAY_SHARED_KEY` | unset | Development/legacy interceptor boundary key |
| `ARBITER_SERVICE_SHARED_KEY` | unset | Verify and state endpoint boundary key |
| `ARBITER_PI_LOCAL_CONFIG` | `~/.arbiter/config.json` | Override local runtime config path |
| `ARBITER_LOCAL_CONFIG` | unset | Shared local config override used when the Pi-specific value is unset |

`ARBITER_URL`, `ARBITER_TENANT_ID`, `ARBITER_ACTOR_ID`, and
`ARBITER_WORKLOAD_TOKEN` are shared aliases for teams that configure several
harness adapters from the same environment. Pi-specific variables take
precedence.

For enterprise use, protect every installed tool and use authenticated workload identity:

```bash
export ARBITER_PI_PROTECT_TOOLS='*'
export ARBITER_PI_ACTOR_ID='pi:engineering-coder'
export ARBITER_PI_BEARER_TOKEN='Bearer <short-lived-workload-jwt>'
export ARBITER_SERVICE_SHARED_KEY='<service-boundary-key>'
pi -e ./integrations/pi-extension
```

Pi extensions execute in-process with the user's permissions. Arbiter can prevent a loaded extension from authorizing a denied call, but it cannot force users to load the extension or replace OS sandboxing and least-privilege credentials. In the Pi lifecycle, permit verification happens in the final pre-execution hook; an isolated external executor should independently verify Arbiter permits when the tool architecture supports it.

## Policy mapping

Pi tool names and inputs are preserved exactly. Built-ins map naturally to Arbiter's filesystem policy:

- `bash` → `{ "command": "..." }`
- `write` → `{ "path": "...", "content": "..." }`
- `edit` → Pi's exact edit arguments

Custom Pi tools work without adapters. Add their names to `ARBITER_PI_PROTECT_TOOLS`, or use `*`, then classify them in Arbiter policy data.
