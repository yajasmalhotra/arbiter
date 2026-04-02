# Security Policy

Arbiter is an alpha-stage security product. Reports that help close real bypasses, replay paths, trust-boundary breaks, or bundle-distribution weaknesses are especially valuable.

## Supported Versions

At the moment, security fixes are targeted at the current `main` branch and the latest published state of the repository.

## Reporting a Vulnerability

Please do not open a public GitHub issue for suspected vulnerabilities.

Use one of these non-public paths instead:

- GitHub private vulnerability reporting for this repository, if it is enabled.
- Email the maintainer at `malhotra.yajas@gmail.com` if private reporting is not enabled.

Please include:

- a clear description of the issue,
- affected component or path,
- reproduction steps or proof of concept,
- impact assessment if known,
- any suggested mitigation if you have one.

You can use the repository name `arbiter` and the commit SHA you tested against.

## What Counts as Security-Relevant

Examples of high-signal reports:

- bypassing policy enforcement,
- executing a tool without a valid signed allow token,
- forging or replaying execution tokens,
- bypassing required-context checks,
- trust-boundary failures between gateway, interceptor, executor, OPA, Redis, or control plane,
- unauthorized bundle fetch, tampering, or signature bypass,
- privilege-escalation paths in control-plane approval, token, or signing-key workflows,
- vulnerabilities that break auditability or integrity of rollout state.

## Out of Scope

These are usually not treated as security vulnerabilities by themselves:

- use of development defaults in local-only demos,
- findings that require repository write access or operator shell access,
- missing hardening that is already documented as alpha or not-yet-supported,
- general best-practice suggestions without a concrete exploit path.

If a report lands in a gray area, it will still be reviewed.

## Disclosure Process

- We will acknowledge receipt of a credible report.
- We may ask follow-up questions or request a narrower proof of concept.
- We prefer coordinated disclosure after a fix or mitigation is available.
- When a fix ships, we may document the issue in release notes or repository history.

## Operational Guidance

Even with Arbiter in place, operators should still use:

- least-privilege credentials for real tools,
- executor isolation or sandboxing where appropriate,
- external secret management,
- network and identity controls around the control plane and policy distribution path.

Arbiter is a guardrail layer, not a full security boundary by itself.
