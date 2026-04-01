# Changelog

All notable changes to `arbiter-integrations` will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [0.1.0] - 2026-03-31

### Added

- Initial Python package metadata and build configuration (`pyproject.toml`).
- `ArbiterHTTPClient` transport wrapper with gateway/service shared-key support.
- LiteLLM/OpenAI helper wrappers (`LiteLLMGuardrail`, envelope builders).
- OpenClaw/generic framework wrappers (`OpenClawGuardrail`, canonical builders).
- Unit tests for LiteLLM and OpenClaw integration helpers.
