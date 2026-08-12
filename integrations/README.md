# Integrations

First-class adoption packages live here.

For the common adapter contract, integration-path decision table, shared
configuration, and conformance checklist, see
[`docs/integrating-local-harnesses.md`](../docs/integrating-local-harnesses.md).

- `python/`: Python wrappers for gateway-driven and agent-native interception/verification.
  - LiteLLM path: `arbiter_integrations.litellm`
  - OpenClaw/generic path: `arbiter_integrations.openclaw`
  - Local runtime discovery: `ArbiterHTTPClient()` can read `~/.arbiter/config.json` when no base URL is provided
  - Packaging metadata: `integrations/python/pyproject.toml`
  - Release docs: `integrations/python/CHANGELOG.md`, `integrations/python/SEMVER.md`
- `openclaw-plugin/`: Native OpenClaw plugin package for hook-level guardrails.
  - Plugin id: `arbiter-openclaw`
  - Package target: `@randromeda/arbiter-openclaw`
  - Local runtime discovery: defaults to `~/.arbiter/config.json` when `arbiterUrl` is not configured
  - Manifest: `integrations/openclaw-plugin/openclaw.plugin.json`
  - Runtime entry: `integrations/openclaw-plugin/index.js`
  - Release docs: `integrations/openclaw-plugin/CHANGELOG.md`, `integrations/openclaw-plugin/SEMVER.md`
- `pi-extension/`: Native Pi extension package for pre-execution tool enforcement.
  - Package target: `@randromeda/arbiter-pi`
  - Hooks: `tool_call` for fail-closed intercept/verify and `tool_result` for state recording
  - Local runtime discovery: defaults to `~/.arbiter/config.json`
  - Runtime entry: `integrations/pi-extension/index.js`
  - Setup and configuration: `integrations/pi-extension/README.md`
  - Reference implementation for new hook-based local harness adapters
- `opencode-plugin/`: Native OpenCode plugin for pre-execution tool enforcement.
  - Package target: `@randromeda/arbiter-opencode`
  - Hooks: `tool.execute.before` for fail-closed intercept/verify and `tool.execute.after` for state recording
  - Protects built-in, custom, and MCP tools exposed through OpenCode
  - Setup and configuration: `integrations/opencode-plugin/README.md`

Run integration tests:

```bash
python3 -m unittest discover integrations/python/tests -v
cd integrations/openclaw-plugin && npm test
cd integrations/pi-extension && npm test
cd integrations/opencode-plugin && npm test
```
