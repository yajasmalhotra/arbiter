# Integrations

First-class adoption packages live here.

- `python/`: Python wrappers for gateway-driven and agent-native interception/verification.
  - LiteLLM path: `arbiter_integrations.litellm`
  - OpenClaw/generic path: `arbiter_integrations.openclaw`
  - Packaging metadata: `integrations/python/pyproject.toml`
  - Release docs: `integrations/python/CHANGELOG.md`, `integrations/python/SEMVER.md`

Run integration tests:

```bash
python3 -m unittest discover integrations/python/tests -v
```
