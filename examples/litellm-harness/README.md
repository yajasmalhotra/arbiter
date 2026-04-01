# LiteLLM → Arbiter manual harness

Python script that:

1. Calls an OpenAI-compatible chat completion (e.g. via **LiteLLM**) so the model returns a `tool_calls` payload, **or** uses `--arbiter-only` with fixed envelopes.
2. Builds Arbiter’s `OpenAIEnvelope` and posts to `POST /v1/intercept/openai`.
3. On allow, posts to `POST /v1/execute/verify/openai` (twice for the `replay` scenario).

Full setup, environment variables, and expected HTTP codes are documented in the repository root [README.md](../../README.md#litellm-manual-harness).

**Client-style test (real model via LiteLLM):** you do not need `pip install litellm`. Run the proxy with Docker from the repo root:

```bash
export OPENAI_API_KEY=sk-...
docker compose -f deploy/docker-compose.yml --profile litellm up -d --build
cd examples/litellm-harness && pip install -r requirements.txt
python3 litellm_arbiter_harness.py allowed
```

Quick start without LiteLLM (Arbiter only):

```bash
pip install -r requirements.txt
python3 litellm_arbiter_harness.py allowed --arbiter-only
```
