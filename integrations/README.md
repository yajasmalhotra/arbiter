# Integrations

First-class adoption packages live here.

- `python/`: Python wrappers for gateway-driven and agent-native interception/verification.
  - LiteLLM path: `arbiter_integrations.litellm`
  - OpenClaw/generic path: `arbiter_integrations.openclaw`

Run integration tests:

```bash
python3 -m unittest discover integrations/python/tests -v
```
