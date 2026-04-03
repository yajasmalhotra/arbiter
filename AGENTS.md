# AGENTS.md

This repository builds Arbiter, a deterministic governance layer for LLM agent tool execution.
Use this file as the working contract for future implementation work.

## Mission

Build a Go-first hot-path enforcement system that intercepts tool calls, normalizes them into a canonical schema, evaluates policy with OPA, and blocks any execution that lacks a valid signed allow token.

The control plane supports policy, bundle, and signing-key governance, but it must stay off the request hot path.

## Current State

- The Go interceptor hot path is implemented: OpenAI, Anthropic, generic framework, and streamed OpenAI tool-call inputs are normalized, evaluated, and signed.
- Token verification is enforced at execution time with replay protection.
- Redis-backed prior-action context is in place for sequence-aware policies.
- The Next.js control plane is functional with JSON fallback storage for local dev and Postgres-backed persistence for production-like runs.
- Bundle distribution, service tokens, and signing-key rotation are implemented in the control plane, and bundle artifacts require the policy tree to be mounted when running in Docker.
- Production rollout approvals are implemented: prod promotions/rollbacks now create approval requests, and only approvers can approve or reject execution.
- Python integration wrappers, LiteLLM harnesses, pilot soak tooling, and a native OpenClaw plugin package (`@randromeda/arbiter-openclaw`) are present.
- CI gates repository hygiene, Go tests, OPA policy tests, control-plane tests, OpenClaw plugin tests, and a Dockerized OPA bundle smoke run.
- Remaining work is mostly production hardening: multi-tenant governance, live pilot execution, dashboard/alert validation, and release automation.

## Runtime Model

Arbiter is a gate, not a judge. The intended flow is:

1. Client or agent sends a tool-call request to a gateway or directly to the interceptor.
2. The interceptor normalizes the provider payload into `internal/schema.CanonicalRequest`.
3. Optional prior-action context is pulled from Redis when required by policy.
4. OPA evaluates Rego policy against the canonical request.
5. If policy allows, the interceptor issues a short-lived signed token bound to the request hash.
6. The tool executor verifies the token again before side effects happen.
7. Audit and telemetry record the decision without blocking the hot path.

The control plane publishes policy bundles and signing material, but it is never in the request path.

## Component Guide

### `cmd/interceptor/`

This is the Go server entrypoint.

- Reads configuration from environment variables.
- Initializes tracing via `internal/telemetry`.
- Creates the state store and replay cache.
- Adds optional Postgres audit fan-out when `ARBITER_AUDIT_POSTGRES_DSN` is set.
- Builds the interceptor service and registers HTTP routes.

Important environment variables:

- `ARBITER_ADDR` sets the listen address, default `:8080`.
- `ARBITER_OPA_URL` and `ARBITER_OPA_PATH` point to the OPA decision endpoint.
- `ARBITER_TOKEN_SECRET` or `ARBITER_TOKEN_KEYS` control execution-token signing.
- `ARBITER_TOKEN_ACTIVE_KID` selects the active signing key when multiple keys are configured.
- `ARBITER_REDIS_ADDR` enables Redis-backed state and replay caches.
- `ARBITER_GATEWAY_SHARED_KEY` and `ARBITER_SERVICE_SHARED_KEY` gate trust-boundary routes.
- `ARBITER_FAST_ALLOWED_TOOLS` defines the allowlist used by the streamed race-gate route.

### `internal/interceptor/`

This package owns request handling and policy orchestration.

- `POST /v1/intercept/openai` accepts a full OpenAI-style envelope, normalizes it, enriches state, calls OPA, and issues a token on allow.
- `POST /v1/intercept/openai/stream` reconstructs streamed chunks before normal interception.
- `POST /v1/intercept/openai/stream/race` starts a fast pre-check as soon as the tool name is visible. It is a bounded early gate, not a replacement for policy.
- `POST /v1/intercept/anthropic`, `POST /v1/intercept/framework/generic`, and `POST /v1/intercept/framework/langchain` do the same for their respective payloads.
- `POST /v1/execute/verify/openai`, `/anthropic`, and `/canonical` verify the token at execution time.
- `POST /v1/state/actions` records prior actions for later sequence-aware lookups.
- `GET /healthz` is liveness.
- `GET /readyz` checks dependency readiness when the backing store or decider exposes a `Ready` method.

Operational behavior:

- Gateway routes are protected by `X-Arbiter-Gateway-Key` when `ARBITER_GATEWAY_SHARED_KEY` is set.
- Service routes are protected by `X-Arbiter-Service-Key` when `ARBITER_SERVICE_SHARED_KEY` is set.
- Unknown or malformed envelopes are rejected before policy evaluation.
- Required context triggers a lookup in the state store; if that lookup fails, the request fails closed.
- The shadow intent labeler may annotate a request, but it cannot block traffic unless explicitly promoted in code.
- The interceptor records decision latency and structured audit events after each decision.

### `internal/schema/`

This is the canonical contract boundary.

- `CanonicalRequest` is the normalized tool-call shape every adapter must produce.
- `SchemaVersion` is versioned from day one and currently `v1alpha1`.
- `Validate` enforces request ID, tenant ID, actor ID, tool name, and JSON parameter validity.
- `Hash` canonicalizes the request and parameters so the signed token can bind to a stable request digest.
- `Decision` carries allow/deny, policy version, data revision, decision ID, and the required-context flag.
- `SignedDecision` is the public response shape from the interceptor.

Do not treat provider JSON as the contract. Provider payloads are always translated into this schema first.

### `internal/translator/`

This package converts provider-native payloads into the canonical request.

- `openai.go` handles standard OpenAI-style tool calls.
- `openai_stream.go` reconstructs streamed tool-call chunks with a hard parameter-size cap.
- `anthropic.go` handles Anthropic `tool_use` payloads.
- `framework.go` handles generic framework and LangChain-style envelopes.

Rules:

- Function tool calls are required for the OpenAI adapter.
- Empty arguments default to `{}` only when that is still valid JSON.
- Stream reconstruction is bounded; never allow unbounded argument buffering.
- Unknown or unsupported tool types are rejected.
- The race-gate route uses the stream assembler early, but final policy evaluation still happens on the canonical request.

### `internal/pdp/`

This is the OPA client.

- It POSTs `{"input": canonical_request}` to the configured OPA endpoint.
- It fails closed on transport failures, non-200 responses, or explicit policy denials.
- `ErrDeniedByPolicy` is the expected deny signal.
- `Ready` checks the OPA health endpoint.

This package should remain deterministic and cheap. Do not add live remote lookups to the hot path.

### `internal/executorauth/`

This package handles execution-time token issuance and verification.

- Tokens are HS256 JWTs.
- Claims are bound to request hash, tenant ID, actor ID, tool name, policy version, and decision ID.
- `kid` support allows signing-key rotation.
- `Verify` checks signature, issuer, audience, request binding, expiry, and replay status.
- Replay protection uses a memory cache by default and Redis when configured.

Token rules:

- Tokens are short-lived.
- Tokens must be verified by the executor, not just by the interceptor.
- Replay is always a hard failure.

### `internal/state/`

This package stores prior tool actions for sequence-aware policy checks.

- `MemoryStore` is in-process and useful for tests.
- `RedisStore` stores recent actions per tenant, actor, and session in a Redis list.
- `RecentActions` returns newest-first history up to the configured limit.
- `RecordAction` is used when the interceptor or an agent runtime wants to persist prior outcomes.

Policies should request `required_context` only when the next decision truly depends on prior actions.

### `internal/intent/`

This is a shadow-mode semantic labeler interface.

- `Labeler` may annotate a canonical request with an intent label.
- `NopLabeler` is the current implementation.
- The labeler must remain non-blocking until product decisions explicitly promote it.

### `internal/audit/`

This package records decisions without blocking enforcement.

- `LogRecorder` writes structured decision logs to `slog`.
- `PostgresRecorder` queues events and persists them asynchronously.
- `MultiRecorder` fans out to multiple sinks.

Important behavior:

- Audit emission must not block the hot path.
- The Postgres recorder drops events if its queue is full and logs a warning instead of stalling requests.
- Audit records should include decision ID, request ID, trace ID, tenant ID, tool name, allow/deny, reason, policy version, and latency.

### `internal/telemetry/`

This package owns tracing and metrics.

- `otel.go` initializes OTLP export when enabled.
- `tracing.go` propagates `X-Arbiter-Trace-ID` through request context and response headers.
- `metrics.go` exposes Prometheus-style counters and latency buckets at `/metrics`.

Use this package to keep observability consistent across the interceptor and support tooling.

### `internal/bundles/`

This is a small shared package for bundle types and digest helpers.

- `types.go` defines rollout states, bundle artifacts, and activations.
- `digest.go` computes stable digests for bundle snapshots.

Use these helpers when bundle identity needs to remain consistent across control plane, tests, and runtime code.

### `policy/`

This directory contains the Rego policy system and bundle metadata.

- `policy/core/authz.rego` is the system-wide policy gate.
- `policy/domain/sql.rego`, `slack.rego`, `stripe.rego`, and `filesystem.rego` are current tool-specific allow rules.
- `policy/data/config.json` holds the data used by policy.
- `policy/arbiter.json` defines the tool registry and bundle metadata that OPA expects.
- `policy/tests/` contains normal, regression, and adversarial fixtures.

Policy behavior:

- Unknown tools are denied.
- Required context without history is denied.
- Domain policies are kept small and deterministic.
- Policy data should never come from live remote calls on the hot path.

### `apps/control-plane/`

This is the governance UI and bundle distribution service.

- `lib/db.ts` runs SQL migrations from `db/migrations` when `ARBITER_DB_URL` or `DATABASE_URL` is set.
- `lib/store.ts` is the main persistence façade. It chooses Postgres first and local JSON fallback second.
- `lib/store_legacy.ts` implements local `.data/control-plane.json` storage for developer environments.
- `lib/auth.ts` enforces `CONTROL_PLANE_API_KEY`, optional tenant fencing via `ARBITER_TENANT_ID`, and optional role-scoped mutation authorization via `ARBITER_CONTROL_PLANE_ENFORCE_RBAC`.
- `lib/context.ts` supplies default tenant and actor IDs.
- `lib/sample-intercept.ts` provides the dashboard test payload.
- The dashboard at `/` shows policy summaries, the policy grid, and recent audit events.

Control-plane routes:

- Policy CRUD and rollout state live under `/api/policies` and `/api/rollouts`.
- Bundle lifecycle lives under `/api/bundles`, `/api/bundles/active`, `/api/bundles/:id/activate`, `/api/bundles/:id/promote`, and channel rollback/artifact/manifest routes.
- Approval workflow routes live under `/api/approvals`, `/api/approvals/:id/approve`, and `/api/approvals/:id/reject`.
- `GET /api/bundles/channels/:channel/manifest` and `GET /api/bundles/channels/:channel/artifact` are the OPA-facing distribution endpoints.
- `GET /api/revisions` and `GET /api/bundles/activations` expose version history.
- `GET /api/audit` surfaces audit history.
- `GET /api/service-tokens`, `POST /api/service-tokens`, and `POST /api/service-tokens/:id/revoke` manage bundle-fetch credentials.
- `GET /api/signing-keys`, `POST /api/signing-keys`, `POST /api/signing-keys/:id/activate`, and `POST /api/signing-keys/:id/revoke` manage bundle-signing rotation.
- Mutating routes require `CONTROL_PLANE_API_KEY` when configured, and `X-Arbiter-Tenant-ID` must match `ARBITER_TENANT_ID` when that fence is enabled.
- With `ARBITER_CONTROL_PLANE_ENFORCE_RBAC=true`, mutation routes also require `X-Arbiter-Role`. `editor` covers policy/rollout/bundle operations and creating prod approval requests, while `approver` is required to approve/reject prod requests plus policy delete and key/token lifecycle operations.

Control-plane storage behavior:

- Postgres mode is the primary production path.
- Local JSON fallback exists only for dev convenience.
- `apps/control-plane/.data/control-plane.json` is generated local state and must remain gitignored and untracked.
- The bundle signer uses the active DB-backed signing key when Postgres is enabled.
- Environment signing values seed or bootstrap the signing path when DB state is unavailable.
- The control-plane bundle builder reads directly from the mounted `policy/` tree, so Docker/Compose runs must provide `ARBITER_POLICY_ROOT=/policy` and mount that directory read-only.
- Bundle archive output includes `.manifest`, policy files from `policy/core` and `policy/domain`, `data.json`, `snapshot.json`, and `.signatures.json`.
- The artifact route may auto-bootstrap a first prod bundle when no prod channel is active yet.
- Signing keys are audited on create, activate, and revoke.

### `integrations/python/`

This is the first-class Python integration package.

- `arbiter_integrations.litellm` wraps OpenAI/LiteLLM-style tool calls.
- `arbiter_integrations.openclaw` wraps generic or OpenClaw-style tool calls.
- `http_client.py` handles HTTP transport and shared-key headers.
- `pyproject.toml`, `CHANGELOG.md`, and `SEMVER.md` define packaging and release behavior.

Use this package when users want a small client-side wrapper instead of writing raw HTTP calls.

### `integrations/openclaw-plugin/`

This is the native OpenClaw plugin package for in-process hook enforcement.

- `index.js` registers `before_tool_call` and `after_tool_call` hooks via OpenClaw plugin SDK entrypoints.
- `src/guardrail.js` executes intercept + verify before protected tool execution and records post-call outcomes.
- `openclaw.plugin.json` defines plugin id, schema, and UI hints for OpenClaw config validation.
- `README.md`, `CHANGELOG.md`, and `SEMVER.md` define install and release behavior.
- The npm package target is `@randromeda/arbiter-openclaw`.
- Default protected tools are `exec`, `process`, `write`, `edit`, and `apply_patch`.

Use this package as the default OpenClaw integration path for hobbyist and pilot setups.

### `examples/litellm-harness/`

This is the client-style validation harness.

- It drives allowed, denied, and replay scenarios against a running Arbiter stack.
- It verifies the full intercept -> token -> verify flow.
- It can run in arbiter-only mode for smoke tests without LiteLLM.

### `tools/pilot/soak_runner.py`

This script is the pilot soak harness.

- It generates sustained allow/deny traffic.
- It verifies execution-token replay behavior.
- It measures latency and compares `/metrics` against a baseline.

Use this script for live pilot validation, not as a unit test replacement.

### `tools/ci/`

This directory contains CI-critical scripts used by GitHub Actions.

- `secret_history_scan.sh` enforces repository hygiene by scanning tracked files, current tree content, and reachable history for secret-like patterns and generated control-plane artifacts.
- `opa_bundle_smoke.sh` boots the Docker stack, waits for control-plane artifact endpoint readiness, verifies OPA bundle activation, and fails on digest mismatch or activation timeout.

These scripts should stay deterministic and non-interactive so CI failures are actionable.

### `.github/workflows/ci.yml`

The repository CI workflow runs in this order:

1. `repo-hygiene` (`./tools/ci/secret_history_scan.sh`)
2. `go-and-policy` (`go test ./...` and `opa test ...`)
3. `control-plane` (`npm ci` and `npm run test` in `apps/control-plane`)
4. `openclaw-plugin` (`npm ci`, `npm test`, and package smoke check)
5. `bundle-smoke` (`./tools/ci/opa_bundle_smoke.sh`)

Use this job order when reproducing CI issues locally.

### `deploy/`

This directory contains deployment wiring and runtime defaults.

- `docker-compose.yml` starts control-plane, Postgres, Arbiter, OPA, Redis, and optional LiteLLM.
- `env.example` documents the runtime environment variables.
- `litellm-config.yaml` configures the optional proxy profile.

Container entrypoints:

- Root `Dockerfile` builds the Go interceptor binary and runs it in a distroless image.
- `apps/control-plane/Dockerfile` builds the Next.js app and runs `npm run start` in production mode.

### `api/`

This directory publishes the public contracts.

- `api/openapi.yaml` is the HTTP API contract.
- `api/schemas/canonical-request.v1alpha1.schema.json` is the canonical request schema.
- `api/schemas/signed-decision.schema.json` is the signed decision response schema.
- `api/examples/` holds example payloads for request and verify flows.

Update these files when request/response shapes change.

## Hot-Path Rules

- No tool executes without a valid signed allow token.
- OPA denial, token validation failure, replay detection, or missing required context must fail closed.
- The control plane must never sit on the request hot path.
- Stream buffering must be bounded.
- Any new network call on the hot path needs an explicit timeout and failure mode.
- Do not trust upstream approval alone; the executor must verify the token itself.

## Working Rules

- Keep hot-path code small, explicit, and allocation-aware.
- Use `context.Context` consistently for cancellation and deadlines.
- Reject unknown or ambiguous payloads unless they normalize safely.
- Version policy and data artifacts so every decision is traceable.
- When adding a new service or package, update `README.md` if the public setup or architecture changes.
- When adding or changing a service boundary, update this file.
- Keep examples aligned with `schema.CurrentSchemaVersion`.

## Testing And Validation

- Run `./tools/ci/secret_history_scan.sh` for repository hygiene and secret-pattern checks before opening PRs.
- Run `go test ./...` for Go code.
- Run `opa test` against `policy/core`, `policy/domain`, `policy/tests`, and `policy/data`.
- Run `npm run test` and `npm run build` in `apps/control-plane` after control-plane changes.
- Run `python3 -m unittest discover integrations/python/tests -v` for Python packaging changes.
- Run `npm test` in `integrations/openclaw-plugin` for native OpenClaw plugin changes.
- Run `npm run pack:check` in `integrations/openclaw-plugin` when package metadata or publish config changes.
- Run `python3 tools/pilot/soak_runner.py` for pilot readiness checks.
- Run `./tools/ci/opa_bundle_smoke.sh` when Docker is available to validate control-plane bundle serving and OPA bundle activation.

## Open Work

1. Finish production multi-tenant governance in the control plane, including tenant-scoped identities, approval ownership, and rollout controls.
2. Run the live pilot soak in target infrastructure and collect artifacts.
3. Validate dashboards, alerting, and OTLP traces against real traffic.
4. Automate integration SDK releases and signing/upload workflows.

## Pilot Sequence

Execute these steps in order. After each step, update this section and `README.md` immediate next steps, then push.

- [x] Step 1: Add edge-case and adversarial policy fixtures in `policy/tests/`.
- [x] Step 2: Add end-to-end integration tests for OPA, Redis, and replay protection.
- [x] Step 3: Add distributed tracing export plumbing (OTLP) and latency SLO instrumentation.
- [x] Step 4: Build control-plane MVP for policy/data CRUD, rollout states, and audit views.
- [x] Step 5: Add key rotation hardening and pilot readiness verification checklist.
- [ ] Step 6: Run the live pilot soak test in the target environment.
- [ ] Step 7: Validate alerting, dashboards, and OTLP-backed traces against real traffic.
