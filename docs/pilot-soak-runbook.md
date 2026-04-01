# Pilot Soak Runbook

Use this runbook to execute Production Pilot Sequence Step 6 and Step 7.

## Prerequisites

1. Deploy Arbiter, OPA, Redis, control-plane, and Postgres in the target environment.
2. Ensure policy bundle distribution is healthy (`/api/bundles/channels/prod/manifest` and OPA bundle status).
3. Set trust-boundary headers if enabled:
   - `ARBITER_GATEWAY_SHARED_KEY`
   - `ARBITER_SERVICE_SHARED_KEY`

## Execute Soak Traffic

Run from repo root:

```bash
python3 tools/pilot/soak_runner.py \
  --arbiter-url http://localhost:8080 \
  --duration-seconds 900 \
  --interval-ms 200 \
  --tenant-id tenant-pilot \
  --actor-id pilot-agent
```

If shared keys are required:

```bash
ARBITER_GATEWAY_SHARED_KEY=... \
ARBITER_SERVICE_SHARED_KEY=... \
python3 tools/pilot/soak_runner.py --arbiter-url http://localhost:8080
```

## Pass Criteria

Step 6 (live soak) passes when:

- script exits `0`
- `allow_intercepts_fail`, `verify_fail`, `deny_intercepts_fail`, and `replay_unexpected` are all `0`
- no readiness/availability incidents occurred during the soak window

Step 7 (alerting/dashboards validation) passes when:

- script reports positive metrics deltas (`arbiter_decisions_total`, allow, deny)
- metrics dashboards reflect the same decision volume trend during the soak window
- trace backend receives spans for interceptor requests (validate by querying trace IDs with `pilot-` prefix from request metadata)
- alert rules stay green (or fire expected warnings only, with documented rationale)

## Artifacts to Save

- soak script JSON output
- dashboard screenshots (decision totals, deny rate, latency buckets)
- trace query screenshots for pilot traffic
- incident/alert timeline for the soak window
