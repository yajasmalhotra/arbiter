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

## API Surface

- `GET /healthz`: Lightweight health endpoint.
- `GET /metrics`: Exposes low-overhead in-process counters in Prometheus text format.
- `POST /v1/intercept/openai`: Normalize an OpenAI-style tool call, evaluate policy, and return a signed token on allow.
- `POST /v1/intercept/openai/stream`: Reconstruct streamed OpenAI tool-call chunks, then apply normal intercept logic.
- `POST /v1/intercept/anthropic`: Normalize an Anthropic tool-use payload.
- `POST /v1/intercept/framework/generic`: Accept framework-native payloads.
- `POST /v1/execute/verify/openai`: Verify a signed token against the normalized execution request and reject replays.
- `POST /v1/execute/verify/anthropic`: Verify a signed token for Anthropic-normalized requests.
- `POST /v1/state/actions`: Record prior actions used for sequence-aware policy checks.

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

## Security Invariants

- No tool executes without a valid signed allow token.
- The executor must verify the token, not just the interceptor.
- Unknown or malformed provider payloads are denied unless they normalize cleanly.
- Missing required temporal context causes a deny for policies that depend on it.
- Every decision is traceable by decision ID, policy version, and data revision.