# OpenClaw Native Plugin

This package provides a native OpenClaw plugin that enforces Arbiter policy decisions for protected tool calls.

Behavior:

- Intercepts protected tools in `before_tool_call`.
- Calls Arbiter `POST /v1/intercept/framework/generic`.
- Requires successful Arbiter verify via `POST /v1/execute/verify/canonical` before execution.
- Records post-call outcomes to `POST /v1/state/actions` (enabled by default).

## Install

Published package target:

1. `@randromeda/arbiter-openclaw`

Install from npm:

```bash
openclaw plugins install @randromeda/arbiter-openclaw
```

Install from local path:

```bash
openclaw plugins install ./integrations/openclaw-plugin
```

## Config

The plugin auto-discovers local runtime settings from `~/.arbiter/config.json` by default.

Minimal local config:

```json
{
  "plugins": {
    "entries": {
      "arbiter-openclaw": {
        "enabled": true,
        "config": {
          "protectTools": ["exec", "process", "write", "edit", "apply_patch"],
          "recordState": true,
          "failClosed": true
        }
      }
    }
  }
}
```

Optional explicit config (for non-local or customized setups):

```json
{
  "plugins": {
    "entries": {
      "arbiter-openclaw": {
        "enabled": true,
        "config": {
          "arbiterUrl": "http://localhost:8080",
          "tenantId": "tenant-demo",
          "gatewayKey": "gw-key",
          "serviceKey": "svc-key"
        }
      }
    }
  }
}
```

Config options:

- `arbiterUrl`: Arbiter base URL. Defaults from local runtime config when available.
- `localConfigPath`: Optional override path for local runtime config. Defaults to `~/.arbiter/config.json`.
- `tenantId`: Tenant ID for canonical requests and state records. Defaults from local runtime config when available.
- `gatewayKey`: Optional key for intercept routes.
- `serviceKey`: Optional key for verify/state routes.
- `actorIdMode`: `agent-id` (default) or `config`.
- `actorId`: Required only when `actorIdMode=config`.
- `protectTools`: Tool names guarded by Arbiter.
- `recordState`: Record outcomes to `/v1/state/actions` (default `true`).
- `failClosed`: Block on Arbiter errors (default `true`).
- `timeoutMs`: Per-request timeout (default `5000`).

Local runtime quick setup:

```bash
go run ./cmd/arbiter local init
go run ./cmd/arbiter local start
```

## Stock OpenClaw Tool Mapping

The default protected tools are:

- `exec`
- `process`
- `write`
- `edit`
- `apply_patch`

Use Arbiter policy to allow or deny these tools. The included Arbiter filesystem policy denies destructive delete commands and `apply_patch` file-deletion directives.

For a safer OpenClaw smoke test, the default policy also denies writes and shell commands that target the canary prefix `/tmp/arbiter-deny-test`. A normal chat prompt such as `Use the exec tool exactly once to run: mkdir -p /tmp/arbiter-deny-test/nested` should trigger an Arbiter block without relying on `rm -rf`.

## Development

Run plugin tests:

```bash
cd integrations/openclaw-plugin
npm test
```

Verify package metadata:

```bash
cd integrations/openclaw-plugin
npm run pack:check
```

## CI Publish

GitHub Actions can publish this package to npm via `.github/workflows/openclaw-plugin-publish.yml`.

Requirements:

- Repository secret `NPM_TOKEN` with publish access to `@randromeda/arbiter-openclaw`.

Publish options:

- Run `npm run release:tag` from `integrations/openclaw-plugin` to create and push `openclaw-plugin-v<version>` automatically.
- For validation without changing git state, run `npm run release:tag -- --dry-run`.
- Or push tag `openclaw-plugin-v<version>` manually (must match `package.json` version), for example `openclaw-plugin-v0.1.0`.
- Or run the `openclaw-plugin-publish` workflow manually from the Actions UI.
