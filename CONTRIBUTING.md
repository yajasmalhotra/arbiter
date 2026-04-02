# Contributing to Arbiter

Thanks for contributing.

Arbiter is building a deterministic guardrail layer for agent tool execution. The project has two priorities that should shape every contribution:

- keep the enforcement hot path small, explicit, and fail-closed,
- keep governance and developer ergonomics understandable enough for outside adopters.

## Before You Start

- Read the root [README.md](README.md) for product scope and current status.
- Read [AGENTS.md](AGENTS.md) for repository-specific architecture and implementation rules.
- If your change affects the control plane, also read [apps/control-plane/README.md](apps/control-plane/README.md).

## Development Setup

### Core Go stack

```bash
go test ./...
```

### Policy tests

```bash
docker run --rm -v "$PWD/policy:/policy:ro" openpolicyagent/opa:latest test /policy/core /policy/domain /policy/tests /policy/data -v
```

### Control plane

```bash
cd apps/control-plane
npm ci
npm run test
```

### Full local stack

```bash
docker compose -f deploy/docker-compose.yml up --build -d
```

## Where Contributions Help Most

- New provider adapters and integration packages.
- Policy authoring examples and adversarial fixtures.
- Control-plane usability for non-technical operators.
- Deployment hardening for pilot and production-style environments.
- Observability, validation, and release automation.

## Contribution Guidelines

### Hot-path changes

- Preserve deterministic behavior.
- Fail closed on verification, policy, or dependency errors unless the design explicitly says otherwise.
- Keep allocations, buffering, and network dependencies bounded.
- Do not route control-plane calls through the intercept path.

### Policy changes

- Keep `policy/core/` for global invariants.
- Keep `policy/domain/` for tool-specific rules.
- Add or update tests in `policy/tests/` for any behavior change.
- Prefer deterministic policy data over live lookups.

### Control-plane changes

- Favor operator clarity over internal cleverness.
- Keep rollout, approval, token, and key-management flows auditable.
- Preserve the separation between governance and enforcement.

### Documentation changes

- Update [README.md](README.md) when the public setup or product story changes.
- Update [AGENTS.md](AGENTS.md) when service boundaries, invariants, or implementation order change.
- Keep examples aligned with the current canonical schema and supported routes.

## Pull Request Expectations

Before opening a PR, make sure you have done the relevant validation for your change:

- `go test ./...`
- OPA policy tests if policy changed
- `npm run test` in `apps/control-plane` if control-plane code changed
- integration or harness tests if SDKs or examples changed

PRs are easier to review when they include:

- the problem being solved,
- the design constraint or invariant involved,
- the validation you ran,
- any known follow-up work or limitations.

## Style Notes

- Prefer small, direct changes over large speculative refactors.
- Keep naming boring and obvious.
- Add comments only where the code is not already self-explanatory.
- Avoid broad rewrites unless they clearly reduce complexity or risk.

## Security

If you think you found a vulnerability, do not open a public issue first. Follow [SECURITY.md](SECURITY.md).
