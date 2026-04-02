# LiteLLM -> Arbiter Manual Harness

This harness is the fastest way to exercise the full client-side flow against Arbiter:

1. generate or simulate a tool call,
2. send it to `POST /v1/intercept/openai`,
3. verify the signed token with `POST /v1/execute/verify/openai`,
4. optionally verify the same token twice to prove replay blocking.

Use it in one of two modes:

- `--arbiter-only` for a fixed local smoke test with no model dependency,
- LiteLLM mode for a real OpenAI-compatible chat-completion path.

## Prerequisites

- A running Arbiter stack from the repo root:

```bash
docker compose -f deploy/docker-compose.yml up --build -d
```

- Python 3

## Install Harness Dependencies

```bash
cd examples/litellm-harness
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Fastest Path: Arbiter-Only Smoke Test

This path does not require LiteLLM or a model API key.

```bash
python3 litellm_arbiter_harness.py allowed --arbiter-only
python3 litellm_arbiter_harness.py denied --arbiter-only
python3 litellm_arbiter_harness.py replay --arbiter-only
```

Expected outcomes:

- `allowed`: intercept succeeds, verify succeeds once
- `denied`: intercept returns a deny
- `replay`: first verify succeeds, second verify is rejected

## Real-Model Path With LiteLLM

You do not need to install the LiteLLM Python package locally. Run the proxy in Docker and point the harness at it.

From the repo root:

```bash
export OPENAI_API_KEY=sk-...
docker compose -f deploy/docker-compose.yml --profile litellm up -d --build
```

Then from `examples/litellm-harness`:

```bash
python3 litellm_arbiter_harness.py allowed
python3 litellm_arbiter_harness.py denied
python3 litellm_arbiter_harness.py replay
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `ARBITER_URL` | `http://localhost:8080` | Arbiter base URL |
| `LITELLM_BASE_URL` | `http://localhost:4000/v1` | OpenAI-compatible gateway URL |
| `LITELLM_API_KEY` | `sk-anything` | gateway bearer token |
| `LITELLM_MODEL` | `gpt-4o-mini` | model exposed through the gateway |

## Expected Results

- `allowed`: intercept returns HTTP `200`, `decision.allow: true`, and a token; verify returns HTTP `200`
- `denied`: intercept returns HTTP `403`, `decision.allow: false`, and no token
- `replay`: first verify returns HTTP `200`; second verify returns HTTP `403`

## Tests

```bash
python3 -m unittest test_litellm_arbiter_harness.py -v
```

For the broader product entrypoint, see the root [README.md](../../README.md).
