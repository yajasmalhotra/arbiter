# AGENTS.md

This repository builds Arbiter, a deterministic governance layer for LLM agent tool execution.
Use this file as the working contract for future implementation work.

## Mission

Build a Go-first hot-path enforcement system that intercepts tool calls, normalizes them into a canonical schema, evaluates policy with OPA, and blocks any execution that lacks a valid signed allow token.

## Architecture Summary

### Hot-path services
- `interceptor`: receives or reconstructs tool-call requests, applies bounded buffering, and orchestrates validation.
- `translator`: converts provider-native tool-call payloads into a versioned canonical contract.
- `pdp`: evaluates Rego policies through a local OPA sidecar and returns allow or deny results.
- `executorauth`: verifies allow tokens at execution time, including expiry, signer, request hash, and replay status.
- `state`: injects prior-action context from Redis for sequence-aware policies.

### Supporting services
- `intent`: semantic labeler used in shadow mode first.
- `control-plane`: Next.js app for policy/data management, audit review, and rollout workflows.
- `audit` and `telemetry`: structured logging, metrics, traces, and latency budget reporting.

## Non-Negotiable Invariants

- No tool executes without a valid signed allow token.
- OPA or token verification failure is always fail-closed.
- The executor must verify the token itself. Do not trust upstream approval alone.
- The labeler is non-blocking until it is explicitly promoted from shadow mode.
- Required temporal context must be present for sequence-aware policies; otherwise deny.
- The control plane must not sit on the request hot path.

## Trust Boundaries

Treat these boundaries as explicit during design and implementation:

1. Agent or client to gateway.
2. Gateway to interceptor.
3. Interceptor to OPA sidecar.
4. Interceptor to Redis-backed state context.
5. Interceptor to tool executor.
6. Control plane to policy and data distribution.

Design against direct tool execution, replayed approvals, forged tokens, stale policy data, and alternate execution paths that bypass the interceptor.

## Recommended Implementation Order

1. Bootstrap the Go module and package layout.
2. Define the canonical schema and version it from day one.
3. Add golden fixtures for OpenAI-style, Anthropic-style, and framework-generated tool calls.
4. Implement the OPA client, base policy packages, and signed allow-token flow.
5. Implement execution-time token verification and replay protection.
6. Build the LiteLLM-first streaming interceptor with strict buffering and timeout limits.
7. Add Redis-backed temporal state enrichment.
8. Build structured audit logging and telemetry.
9. Add the control plane for policy rollout and simulation.
10. Integrate the intent labeler in shadow mode only.

## Repository Expectations

Prefer this layout unless a strong reason emerges to change it:

```text
cmd/interceptor/
internal/schema/
internal/translator/
internal/pdp/
internal/executorauth/
internal/state/
internal/intent/
internal/audit/
internal/telemetry/
policy/core/
policy/domain/
policy/data/
policy/tests/
apps/control-plane/
deploy/
```

## Implementation Guidelines

### Go hot path
- Keep hot-path logic small, explicit, and allocation-aware.
- Use `context.Context` consistently for deadlines and cancellation.
- Bound memory use for streamed argument buffering.
- Propagate structured errors with enough metadata for audit logs.

### Canonical schema
- Treat the canonical schema as the contract boundary, not provider JSON.
- Include schema version, tenant, actor, session metadata, tool name, normalized parameters, derived state context, and decision metadata.
- Reject unknown or ambiguous payloads unless they normalize safely.

### Policy design
- Separate `policy/core/` for system-wide invariants from `policy/domain/` for tool-specific controls.
- Keep policy evaluation deterministic and cheap.
- Do not pull live remote data from Rego on the hot path.
- Version policy and data artifacts so every decision is traceable.

### Token design
- Bind tokens to request hash, tenant, actor, tool, policy version, expiry, and `jti`.
- Keep tokens short-lived.
- Plan for replay protection and key rotation from the start.

### Control plane
- Keep it out of the request path.
- Support `draft`, `shadow`, `canary`, `enforced`, and rollback workflows.
- Show decision history, policy versions, and simulation results.

## Testing Standards

- Create tests for every package with business logic.
- Add golden tests for normalization and schema compatibility.
- Add `opa test` coverage for policy behavior.
- Add replay tests for policy revisions and shadow mode.
- Add fuzz tests for malformed payloads and stream reconstruction.
- Add load and fault-injection coverage for OPA, Redis, and labeler dependency failure modes.

## Documentation Discipline

When adding a new service or package:

- Update `README.md` if the public architecture or setup story changes.
- Update this file if the service boundary, implementation order, or invariants change.
- Keep examples aligned with the current canonical schema version.

## Build Progress

- [x] Bootstrap the Go module and package layout.
- [x] Define the versioned canonical schema and request hashing.
- [x] Add OpenAI normalization and golden-style translation tests.
- [x] Implement OPA decisioning and signed execution-token flow.
- [x] Implement execution-time token verification with replay protection.
- [x] Build the HTTP interception service and action-recording endpoints.
- [x] Add initial Rego policies, policy data, and local Docker runtime wiring.
- [x] Add focused unit tests for schema, translation, PDP, token verification, state, and service handlers.
- [x] Add streamed tool-call chunk reconstruction.
- [x] Add Anthropic adapter.
- [x] Add framework adapters.
- [x] Add first-class tracing.
- [x] Add CI automation for `go test` and `opa test`.
- [x] Add first-class in-process metrics and `/metrics` endpoint.
- [x] Expand baseline policy regression coverage for SQL, Slack, Stripe, and temporal context.
- [x] Add chunk-phase stream intercept route with fast early deny gate.
- [ ] Build the control-plane application.

## Immediate Build Targets

The next code changes should usually start here:

1. `policy/tests/` to add edge-case and adversarial fixtures.
2. `apps/control-plane/` for governance workflows and simulation.
3. End-to-end integration tests that exercise OPA, Redis, and replay protection together.
4. Distributed tracing export plumbing (OTLP) on top of current trace propagation.

## Production Pilot Sequence

Execute these steps in order. After each step, update this section and `README.md` immediate next steps, then push.

- [ ] Step 1: Add edge-case and adversarial policy fixtures in `policy/tests/`.
- [x] Step 1: Add edge-case and adversarial policy fixtures in `policy/tests/`.
- [x] Step 2: Add end-to-end integration tests for OPA, Redis, and replay protection.
- [x] Step 3: Add distributed tracing export plumbing (OTLP) and latency SLO instrumentation.
- [x] Step 4: Build control-plane MVP for policy/data CRUD, rollout states, and audit views.
- [ ] Step 5: Add key rotation hardening and pilot readiness verification checklist.
