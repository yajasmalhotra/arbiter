# Changelog

All notable changes to `@randromeda/arbiter-openclaw` will be documented in this file.

## [0.1.1] - 2026-04-03

- Added local runtime auto-discovery from `~/.arbiter/config.json`.
- Added optional `localConfigPath` override in plugin config.
- Removed environment-variable fallback wiring from plugin runtime setup.

## [0.1.0] - 2026-04-02

- Initial native OpenClaw plugin implementation.
- `before_tool_call` enforcement with Arbiter intercept + verify.
- `after_tool_call` state recording support.
- Config schema, package metadata, and local/npm install docs.
- Unit tests for config, deny/allow paths, and state recording.
