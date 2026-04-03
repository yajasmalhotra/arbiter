# Integrations

First-class adoption packages live here.

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

Run integration tests:

```bash
python3 -m unittest discover integrations/python/tests -v
cd integrations/openclaw-plugin && npm test
```
