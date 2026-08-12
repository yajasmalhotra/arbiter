# Arbiter for OpenCode

Native OpenCode plugin that enforces Arbiter policy before built-in, custom,
and MCP tool execution. OpenCode runs locally; this plugin runs in-process and
uses its `tool.execute.before` and `tool.execute.after` hooks.

## Install

Package target after its npm release:

```bash
opencode plugin @randromeda/arbiter-opencode
```

OpenCode adds the package to `opencode.json` and installs it with Bun on the
next startup.

During repository development, import `integrations/opencode-plugin/index.js`
from a project plugin under `.opencode/plugins/`.

The package and its exported plugin were load-tested with OpenCode 1.18.16.

Start the local runtime first:

```bash
go run ./cmd/arbiter local init
go run ./cmd/arbiter local start
```

The plugin discovers `~/.arbiter/config.json`, fails closed by default, and
protects `bash`, `edit`, `write`, and `apply_patch`. Set
`ARBITER_OPENCODE_PROTECT_TOOLS='*'` to protect every built-in, custom, and MCP
tool exposed through OpenCode.

Harness-specific variables use the `ARBITER_OPENCODE_` prefix. Shared
`ARBITER_URL`, `ARBITER_TENANT_ID`, `ARBITER_ACTOR_ID`, and
`ARBITER_WORKLOAD_TOKEN` aliases are also supported, with harness-specific
values taking precedence.

The plugin calls Arbiter intercept and permit verification before returning
from the pre-execution hook. It records state only after OpenCode reports that
the verified tool executed successfully.

Like every in-process hook, this plugin cannot force a user to load it. Use
least-privilege tool credentials or an external execution boundary where
bypass resistance is required.
