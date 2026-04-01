# Pilot Readiness Checklist

This checklist is the gate for calling Arbiter production-pilot ready.

## Security and Token Hardening

- [x] Signed decision token required for execution authorization.
- [x] Replay protection enforced with memory or Redis cache.
- [x] Request-hash and actor/tool binding verified at execution time.
- [x] Key ID (`kid`) support added for signing key rotation.
- [x] Multi-key verification support for active and previous signing keys.

## Policy and Governance

- [x] Baseline and adversarial Rego policy tests added.
- [x] Rollout states supported in control-plane model (`draft`, `shadow`, `canary`, `enforced`, `rolled_back`).
- [x] Policy CRUD and rollout transition endpoints available in control-plane MVP.

## Reliability and Observability

- [x] Metrics endpoint with decision counters and latency histogram buckets.
- [x] Trace ID propagation via `X-Arbiter-Trace-ID`.
- [x] OTLP exporter configuration support for tracing.

## Integration Validation

- [x] End-to-end tests for intercept and verify flows.
- [x] End-to-end tests for Redis-backed replay protection.
- [x] End-to-end tests for required-context flow with Redis-backed history.

## Operational Baseline

- [x] CI workflow runs `go test`.
- [x] CI workflow runs `opa test`.
- [ ] Run live pilot soak test in target environment.
- [ ] Validate alerting and dashboards against real traffic.

Execution notes:

- Use `python3 tools/pilot/soak_runner.py` to generate sustained allow/deny/replay traffic and validate metrics deltas.
- Use `docs/pilot-soak-runbook.md` for step-by-step pass criteria and artifact collection.
