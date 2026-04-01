# Arbiter

Arbiter is a deterministic governance layer for LLM agent tool execution. It sits between an agent runtime (like LiteLLM, LangChain, or direct OpenAI/Anthropic calls) and the tools that agent wants to call. 

The product goal is simple: **Agent reasoning can stay probabilistic, but tool execution must be deterministic.**

Instead of relying on an LLM to "judge" if an action is safe, Arbiter normalizes tool-call payloads into a canonical schema, evaluates them against strict Rego policies using Open Policy Agent (OPA), and only allows execution when a short-lived, cryptographically signed policy token is present and valid.

## Why Arbiter?

When deploying LLM agents to production, you cannot trust the LLM to police its own tool usage. Prompt injection, hallucinations, and probabilistic reasoning make "LLM-as-a-judge" guardrails unsafe for destructive actions (like `DROP TABLE` or issuing refunds).

Arbiter provides:
- **Deterministic Enforcement:** Uses OPA and Rego policies. If a rule says "No refunds over $5,000", the LLM cannot bypass it.
- **Cryptographic Trust:** Issues short-lived, signed JWTs for allowed actions. The tool executor verifies the token, ensuring the request wasn't tampered with.
- **Replay Protection:** Tokens are bound to the request hash and can only be used once.
- **Multi-Provider Support:** Normalizes OpenAI, Anthropic, and generic framework payloads into a single canonical schema.
- **Sequence-Aware Policies:** Integrates with Redis to enforce rules like "You can only delete a database if you backed it up in the last 5 minutes."

## Quick Start

### 1. Run the Stack Locally

Arbiter requires OPA and Redis to run. You can spin up the entire stack using Docker Compose:

```bash
docker compose -f deploy/docker-compose.yml up --build -d
```

This starts:
- **Arbiter** on `http://localhost:8080`
- **OPA** on `http://localhost:8181` (with policies mounted from `policy/`)
- **Redis** on `localhost:6379`

Optional **LiteLLM proxy** on `http://localhost:4000` (for client-style harness tests): set `OPENAI_API_KEY`, then run `docker compose -f deploy/docker-compose.yml --profile litellm up -d --build` (see [LiteLLM manual harness](#litellm-manual-harness)).

### 2. Test an Allowed Action

Let's simulate an LLM trying to send a Slack message to the `#ops` channel. Our default policy allows this.

```bash
curl -s -X POST http://localhost:8080/v1/intercept/openai \
  -H 'Content-Type: application/json' \
  -d '{
    "metadata": {"request_id": "demo-1", "tenant_id": "tenant-demo"},
    "agent_context": {"actor": {"id": "user-1"}},
    "tool_call": {
      "type": "function",
      "function": {
        "name": "send_slack_message",
        "arguments": "{\"channel\":\"ops\",\"message\":\"Deploy finished\"}"
      }
    }
  }'
```

**Response:**
You will receive an HTTP 200 with `"allow": true` and a signed JWT `token`. Your application should extract this token and pass it to the tool executor.

### 3. Test a Denied Action

Now let's simulate the LLM trying to drop a database table. Our default policy explicitly denies destructive SQL.

```bash
curl -s -X POST http://localhost:8080/v1/intercept/openai \
  -H 'Content-Type: application/json' \
  -d '{
    "metadata": {"request_id": "demo-2", "tenant_id": "tenant-demo"},
    "agent_context": {"actor": {"id": "user-1"}},
    "tool_call": {
      "type": "function",
      "function": {
        "name": "run_sql_query",
        "arguments": "{\"query\":\"DROP TABLE users;\"}"
      }
    }
  }'
```

**Response:**
You will receive an HTTP 403 Forbidden with `"allow": false` and no token. The action is blocked deterministically.

### 4. Verify the Token at Execution Time

Before your actual tool (e.g., your Slack integration) executes the action, it must verify the token with Arbiter to ensure it is valid, hasn't expired, and hasn't been replayed.

```bash
curl -s -X POST http://localhost:8080/v1/execute/verify/openai \
  -H 'Content-Type: application/json' \
  -d '{
    "token": "<PASTE_TOKEN_FROM_STEP_2>",
    "envelope": {
      "metadata": {"request_id": "demo-1", "tenant_id": "tenant-demo"},
      "agent_context": {"actor": {"id": "user-1"}},
      "tool_call": {
        "type": "function",
        "function": {
          "name": "send_slack_message",
          "arguments": "{\"channel\":\"ops\",\"message\":\"Deploy finished\"}"
        }
      }
    }
  }'
```

If successful, Arbiter returns `{"status": "verified"}`. If you run this exact same command again, Arbiter will return a 403 `token replay detected` error.

## LiteLLM manual harness

Use this when you want a model (via a LiteLLM OpenAI-compatible proxy) to emit a tool call, then run the same **intercept → verify** flow against Arbiter.

### Prerequisites

1. **Arbiter stack** (from [Quick Start](#1-run-the-stack-locally)): `docker compose -f deploy/docker-compose.yml up --build -d` so Arbiter is on `http://localhost:8080`.
2. **LiteLLM** (or any OpenAI-compatible gateway) on `http://localhost:4000/v1` with a configured model (see below).
3. **Python 3** and the harness dependencies:

```bash
cd examples/litellm-harness
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### Client-style test: LiteLLM in Docker (no local pip install of LiteLLM)

You do **not** need to install the LiteLLM Python package on your machine. Run the official proxy image via Compose (same pattern a client app would use: gateway on port 4000, your app calls it).

1. **Get an OpenAI API key** (or change `deploy/litellm-config.yaml` to another provider supported by LiteLLM).

2. **Start Arbiter and LiteLLM**:

```bash
export OPENAI_API_KEY=sk-...   # your provider key
docker compose -f deploy/docker-compose.yml --profile litellm up -d --build
```

This starts Arbiter/OPA/Redis as usual and adds **LiteLLM** on `http://localhost:4000`. The proxy uses `deploy/litellm-config.yaml` and forwards `gpt-4o-mini` to OpenAI using `OPENAI_API_KEY`.

Optional: copy `deploy/env.example` to `deploy/.env`, set `OPENAI_API_KEY`, then run:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile litellm up -d --build
```

3. **Run the harness** (from `examples/litellm-harness` after `pip install -r requirements.txt`). Defaults match the Compose proxy (`LITELLM_BASE_URL=http://localhost:4000/v1`, `LITELLM_API_KEY=sk-anything` matching `LITELLM_MASTER_KEY` in Compose):

```bash
python3 litellm_arbiter_harness.py allowed
python3 litellm_arbiter_harness.py denied
python3 litellm_arbiter_harness.py replay
```

If you change `LITELLM_MASTER_KEY` in Compose, set `LITELLM_API_KEY` to the same value when running the harness.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARBITER_URL` | `http://localhost:8080` | Arbiter HTTP base URL |
| `LITELLM_BASE_URL` | `http://localhost:4000/v1` | OpenAI-compatible base URL (LiteLLM) |
| `LITELLM_API_KEY` | `sk-anything` | Bearer token the proxy expects (`LITELLM_MASTER_KEY` in Docker) |
| `LITELLM_MODEL` | `gpt-4o-mini` | Model name exposed by the proxy (`model_name` in `deploy/litellm-config.yaml`) |

### Run the harness (with LiteLLM)

From `examples/litellm-harness` (with a running LiteLLM-compatible gateway as above):

```bash
# Allowed: model calls send_slack_message → intercept 200 + token → verify once
python3 litellm_arbiter_harness.py allowed

# Denied: forced run_sql_query with destructive SQL → intercept 403, allow=false
python3 litellm_arbiter_harness.py denied

# Replay: same as allowed, then verify twice (second call must 403)
python3 litellm_arbiter_harness.py replay
```

**Expected outcomes**

- `allowed` / `replay` (first verify): intercept **200**, `decision.allow: true`, non-empty `token`; verify **200** with `{"status":"verified"}`.
- `denied`: intercept **403**, `decision.allow: false`, no `token`.
- `replay` (second verify): **403** with an error body mentioning replay (e.g. `token replay detected`).

### Arbiter-only smoke test (no LiteLLM)

To validate the stack and policies without a running model:

```bash
python3 litellm_arbiter_harness.py allowed --arbiter-only
python3 litellm_arbiter_harness.py denied --arbiter-only
python3 litellm_arbiter_harness.py replay --arbiter-only
```

### When to use `/v1/intercept/openai/stream`

The harness uses **`POST /v1/intercept/openai`** with a complete tool call in the envelope (typical after a non-streaming chat completion).

If your gateway **streams** tool-call deltas, reconstruct chunks in the shape expected by Arbiter (`metadata`, `agent_context`, optional `required_context`, `chunks` with `function_name` / `arguments_delta`) and send them to **`POST /v1/intercept/openai/stream`** instead. See `internal/translator/openai.go` for the JSON contract.

### Tests

```bash
cd examples/litellm-harness
python3 -m unittest test_litellm_arbiter_harness.py -v
```

## API Surface

- `GET /healthz`: Lightweight health endpoint.
- `GET /readyz`: Readiness endpoint; returns 503 if dependencies are unavailable.
- `GET /metrics`: Exposes low-overhead in-process counters in Prometheus text format.
- `POST /v1/intercept/openai`: Normalize an OpenAI-style tool call, evaluate policy, and return a signed token on allow.
- `POST /v1/intercept/openai/stream`: Reconstruct streamed OpenAI tool-call chunks, then apply normal intercept logic.
- `POST /v1/intercept/anthropic`: Normalize an Anthropic tool-use payload.
- `POST /v1/intercept/framework/generic`: Accept framework-native payloads.
- `POST /v1/execute/verify/openai`: Verify a signed token against the normalized execution request and reject replays.
- `POST /v1/execute/verify/anthropic`: Verify a signed token for Anthropic-normalized requests.
- `POST /v1/execute/verify/canonical`: Provider-agnostic verify endpoint for canonical requests.
- `POST /v1/state/actions`: Record prior actions used for sequence-aware policy checks.

### Optional Trust-Boundary Headers

When auth keys are configured, callers must include:

- `X-Arbiter-Gateway-Key` on intercept routes (`ARBITER_GATEWAY_SHARED_KEY`).
- `X-Arbiter-Service-Key` on verify/state routes (`ARBITER_SERVICE_SHARED_KEY`).

## Published Contracts

- OpenAPI: `api/openapi.yaml`
- Canonical schema: `api/schemas/canonical-request.v1alpha1.schema.json`
- Decision schema: `api/schemas/signed-decision.schema.json`
- Example payloads: `api/examples/`

## Writing Policies

Policies are written in Rego and evaluated by OPA. 
- **Core policies** (like schema validation and global invariants) live in `policy/core/`.
- **Domain policies** (like Slack channel allowlists or Stripe refund caps) live in `policy/domain/`.
- **Policy data** (configuration values like the actual refund cap amount) live in `policy/data/config.json`.

To test policies locally:
```bash
go test ./...
docker run --rm -v $(pwd)/policy:/policy:ro openpolicyagent/opa:0.69.0 test /policy/core /policy/domain /policy/tests /policy/data -v
```

## Control Plane UI

Arbiter includes a Next.js application for policy data CRUD, audit review, and shadow simulation.

```bash
cd apps/control-plane
npm install
npm run dev
```
Open `http://localhost:3000` to view the dashboard.

### Bundle Lifecycle APIs

- `GET /api/bundles`
- `POST /api/bundles`
- `GET /api/bundles/active`
- `GET /api/bundles/:id`
- `POST /api/bundles/:id/activate`
- `GET /api/bundles/activations`
- `GET /api/revisions`

Mutating control-plane APIs can be protected with `CONTROL_PLANE_API_KEY`, using header `X-Arbiter-Control-Key`.

## Security Invariants

- No tool executes without a valid signed allow token.
- The executor must verify the token, not just the interceptor.
- Unknown or malformed provider payloads are denied unless they normalize cleanly.
- Missing required temporal context causes a deny for policies that depend on it.
- Every decision is traceable by decision ID, policy version, and data revision.
