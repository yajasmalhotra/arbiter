# Control Plane MVP

This Next.js application provides an initial governance control plane for Arbiter.

## Capabilities

- Policy CRUD endpoints:
  - `GET /api/policies`
  - `POST /api/policies`
  - `GET /api/policies/:id`
  - `PUT /api/policies/:id`
  - `DELETE /api/policies/:id`
- Rollout state APIs:
  - `GET /api/rollouts`
  - `POST /api/rollouts`
- Bundle APIs:
  - `GET /api/bundles`
  - `POST /api/bundles`
  - `GET /api/bundles/active`
  - `GET /api/bundles/:id`
  - `POST /api/bundles/:id/activate`
  - `POST /api/bundles/:id/promote`
  - `GET /api/bundles/activations`
  - `GET /api/bundles/artifacts/:id`
  - `GET /api/bundles/channels/:channel/manifest`
  - `GET /api/bundles/channels/:channel/artifact`
  - `POST /api/bundles/channels/:channel/rollback`
- Approval APIs:
  - `GET /api/approvals`
  - `POST /api/approvals/:id/approve`
  - `POST /api/approvals/:id/reject`
- Service token APIs:
  - `GET /api/service-tokens`
  - `POST /api/service-tokens`
  - `POST /api/service-tokens/:id/revoke`
- Signing key APIs:
  - `GET /api/signing-keys`
  - `POST /api/signing-keys`
  - `POST /api/signing-keys/:id/activate`
  - `POST /api/signing-keys/:id/revoke`
- Capability-grant APIs:
  - `GET /api/capability-grants`
  - `POST /api/capability-grants`
  - `POST /api/capability-grants/:id/revoke`
- Revision APIs:
  - `GET /api/revisions`
- Audit read API:
  - `GET /api/audit`
- Policy test proxy (calls a running Arbiter interceptor):
  - `POST /api/policies/:id/test` — body: `{ interceptPath?, payload, arbiterBaseUrl? }`. Server uses `ARBITER_URL` (default `http://127.0.0.1:8080`) unless `arbiterBaseUrl` is set.
- Dashboard at `/` with **AG Grid** policy table, summary pills, and recent audit events.
- Dashboard now includes guided workflow cards and client-side connection settings for secured control-plane headers.
- Policy detail at `/policies/:id`: view/edit fields and **Test against Arbiter** (edit JSON body, pick intercept route, run).
- **Create Policy** at `/policies/new` (sidebar + empty grid CTA). Sidebar: **Dashboard**, **Create Policy**.
- Operations workspace at `/operations` for bundle release requests, approval queue actions, rollbacks, service token lifecycle, and signing-key lifecycle.
- UI uses **shadcn/ui** (Tailwind CSS, Radix primitives) and **AG Grid** for the policy table.

## Local Run

```bash
cd apps/control-plane
npm install
npm run dev
```

Data is persisted in `apps/control-plane/.data/control-plane.json` by default.
Set `ARBITER_DB_URL` (or `DATABASE_URL`) to enable Postgres-backed persistence and SQL migrations from `db/migrations`.
When running in Docker, mount the repo `policy/` directory into the container and set `ARBITER_POLICY_ROOT=/policy` so bundle artifacts can include the live Rego sources.

If `CONTROL_PLANE_API_KEY` is set, mutating APIs require header `X-Arbiter-Control-Key`.
If `ARBITER_TENANT_ID` is set, mutating APIs also require `X-Arbiter-Tenant-ID` to match the configured tenant.
If `ARBITER_CONTROL_PLANE_ENFORCE_RBAC=true`, role-scoped mutation checks are enabled via `X-Arbiter-Role`:

- `editor` can publish bundles, update policies, change rollout state, and create prod approval requests.
- `approver` is required to approve/reject prod rollout requests, plus policy delete, service-token operations, and signing-key operations.

### Enterprise signed identity

For direct enterprise OIDC, set `ARBITER_CONTROL_PLANE_OIDC_JWKS_URL`,
`ARBITER_CONTROL_PLANE_OIDC_ISSUER`, and
`ARBITER_CONTROL_PLANE_OIDC_AUDIENCE` (default `arbiter-control-plane`).
Arbiter validates short-lived RS256 bearer tokens against a bounded, cached
JWKS; configure `ARBITER_CONTROL_PLANE_OIDC_JWKS_CACHE_TTL_MS` to adjust the
five-minute default cache. Alternatively, set `ARBITER_CONTROL_PLANE_JWT_SECRET`
when an identity-aware gateway issues internal short-lived HS256 tokens. The
HS256 mode accepts optional `ARBITER_CONTROL_PLANE_JWT_ISSUER` and
`ARBITER_CONTROL_PLANE_JWT_AUDIENCE` settings.

Both modes require `sub`, `tenant_id`, non-empty `roles`, and `exp` claims;
`roles` may be an array or comma-separated string using `viewer`, `editor`,
`approver`, or `admin`.

Signed identity takes precedence over every client-controlled tenant and role
header. The authenticated tenant and subject become the request-scoped store
tenant and audit actor, so concurrent tenants cannot select each other's
control-plane records through a request body or browser setting. In this mode,
RBAC is enforced even if `ARBITER_CONTROL_PLANE_ENFORCE_RBAC` is unset. Do not
put the signing secret in a browser; the dashboard accepts the already-issued
bearer token in Connection Settings and stores the token in a same-site cookie
so server-rendered pages can establish the same tenant context. Header RBAC remains for development and
requires `CONTROL_PLANE_API_KEY` when enabled.

The persistence facade also propagates that authoritative actor through its
local fallback paths. A supplied `actor` request field is therefore useful only
for trusted server-side jobs when no signed identity context exists; it cannot
impersonate an authenticated operator.

Bundle service tokens are also tenant-bound: the OPA artifact and manifest
routes derive the store tenant from the validated token hash rather than a
request header or process-default tenant.

### Tamper-evident audit evidence

Postgres-backed audit events are chained per tenant using SHA-256 hashes over a
canonical event payload and the preceding event hash. Concurrent writes take a
tenant advisory lock so the chain has one deterministic order. Use
`GET /api/audit/verify` with viewer access to verify the current tenant's
chain. Events that predate migration `0005_audit_integrity.sql` remain visible
but are reported as unsealed legacy history; local JSON development storage
does not provide audit-chain verification.

High-volume runtime enforcement decisions use the separate
`runtime_audit_events` table. This keeps operational decision telemetry from
introducing unsealed rows into the governance audit chain; gateway readiness
fails if its bounded runtime-audit queue drops an event or Postgres persistence
fails.

Use `/decisions` to investigate runtime outcomes with exact allow, deny,
would-deny, tool, and
decision/request/trace-ID filters. Queries are tenant-scoped, bounded to 100
records, and cursor-paginated; only normalized decision metadata is returned,
never raw tool parameters.

The dashboard summarizes the last 24 hours of enforcement volume, blocked
calls, shadow would-deny calls, policy denial rate, and top blocked tools.
Automation can read the same tenant-scoped
aggregate from `GET /api/runtime-audit/summary?hours=24`; the window is bounded
between one hour and 30 days.

Policy detail pages support live allow/deny assertions against a connected
interceptor. The test endpoint requires viewer access and adopts the signed
tenant context before loading a policy. In production, configure `ARBITER_URL`,
`ARBITER_POLICY_TEST_GATEWAY_KEY`, and optionally
`ARBITER_POLICY_TEST_BEARER_TOKEN`; arbitrary browser-supplied target overrides
are disabled unless `ARBITER_ALLOW_TEST_URL_OVERRIDE=true`. Override targets
never receive the configured server credentials. Set
`ARBITER_POLICY_TEST_TIMEOUT_MS` to tune the bounded 10-second request timeout.

Editors can save up to 50 named allow/deny regression scenarios per policy.
Viewers can run the suite against the configured interceptor with five
concurrent requests. The control plane retains each scenario's last observed
outcome and pass/fail state, and writes one tenant-scoped governance audit event
per suite run.

Production channel safeguards:

- `POST /api/bundles/:id/promote` with `channel=prod` creates a pending approval request.
- `POST /api/bundles/channels/prod/rollback` creates a pending approval request.
- Direct prod activation/rollback is blocked until an approver executes `/api/approvals/:id/approve`.
- A production requester cannot approve their own request. The control plane
  enforces this separation of duties in the store transaction, so it holds for
  API and dashboard clients alike.

Observe-before-enforce rollout:

- Bundles published with `rolloutState=shadow` carry a signed
  `enforcement_mode=shadow` into OPA data and the bundle manifest.
- Policy still computes the raw verdict, but a shadow denial becomes an
  effective allow. Runtime audit records retain both `allow=true` and
  `policy_allow=false`, along with the policy package/version and data revision.
- The dashboard and decision explorer label and filter these calls as
  **Would deny**, and `/metrics` exposes `arbiter_shadow_would_deny_total`.
- Promotion to the production channel changes the bundle to `enforced` before
  it is served. Shadow mode cannot silently carry into production.

Bundle artifact endpoints require `Authorization: Bearer <token>` and validate against `ARBITER_BUNDLE_SERVICE_TOKEN`/`ARBITER_BUNDLE_SERVICE_TOKEN_SCOPES`.
Published bundle archives include `.signatures.json` and are signed by the active signing key.
For enterprise deployment, create an `RS256` signing key (or set the bootstrap
algorithm to `RS256`). The control plane keeps the PEM-encoded RSA private key;
each OPA verifier receives only the matching public key through its own trusted
deployment configuration. That avoids sharing a bundle-signing secret with every
verifier. Configure OPA with the matching key ID, `algorithm: RS256`, and public
key under `keys.<key-id>.key`; keep key rollout and verifier configuration
separate from bundle delivery.

For the reference Compose deployment, set `ARBITER_BUNDLE_VERIFYING_KEY` for
OPA independently from `ARBITER_BUNDLE_SIGNING_SECRET`: it is the RSA public
key for `RS256`, while legacy `HS256` requires the same shared secret in both
variables. The Compose file never maps the control-plane signing private key
into the OPA container for an RS256 deployment.

`HS256` is retained for local development and backward compatibility, but it
requires every verifier to hold the same signing secret. In Postgres mode,
signing-key material is encrypted at rest with AES-256-GCM and bound to its
tenant and key ID. `ARBITER_SIGNING_KEY_ENCRYPTION_KEY` must be a unique,
base64-encoded 32-byte value supplied through your secret manager; it is
required by default in production. Existing plaintext records must be rotated
after enabling encryption. In fallback mode, signing uses:

- `ARBITER_BUNDLE_SIGNING_ALGORITHM` (`HS256` default; use `RS256` for enterprise)
- `ARBITER_BUNDLE_SIGNING_KEY_ID`
- `ARBITER_BUNDLE_SIGNING_SCOPE`
- `ARBITER_BUNDLE_SIGNING_SECRET` (RSA private-key PEM for `RS256`)
- `ARBITER_SIGNING_KEY_ENCRYPTION_KEY` (required for Postgres signing-key storage in production)

### External KMS/HSM signer

For the strongest production boundary, configure
`ARBITER_BUNDLE_SIGNER_URL` with an HTTPS signing service backed by your KMS or
HSM and set `ARBITER_BUNDLE_SIGNING_ALGORITHM=RS256`. Arbiter sends a
request containing the JWT signing input, key ID, algorithm, and scope; the
service responds with JSON of the form
`{"signature":"<base64url RS256 signature>"}`. Use
`ARBITER_BUNDLE_SIGNER_TOKEN` to authenticate the request and
`ARBITER_BUNDLE_SIGNER_TIMEOUT_MS` (default `3000`) to bound the call. When
this integration is enabled, bundle generation does not load or persist a
private signing key. The signer URL must use HTTPS in production, and failures
fail closed rather than emitting an unsigned bundle.

Capability grants are available only with Postgres persistence. In production,
set `ARBITER_CAPABILITY_ALGORITHM=RS256` and provide the PEM-encoded
`ARBITER_CAPABILITY_PRIVATE_KEY` only to the control plane. Configure each MCP
gateway with the matching `ARBITER_CAPABILITY_PUBLIC_KEY` and the same key ID,
issuer, and audience; gateways then verify grants without holding signing
material. HS256 via `ARBITER_CAPABILITY_SECRET` remains supported for local
development and existing deployments. Creating a grant returns its signed
credential once; the response record contains only non-secret metadata. A grant
can optionally be tied to a workload identity (such as a SPIFFE URI) that the
MCP gateway has authenticated through mTLS or a workload JWT. Use Redis-backed
revocation for distributed invalidation.

To rotate an RS256 capability key without invalidating active grants, first add
the future public key to each gateway's
`ARBITER_CAPABILITY_ADDITIONAL_PUBLIC_KEYS_JSON` map, then switch the control
plane's `ARBITER_CAPABILITY_KID` and private key. Retain the old public key
until all grants it signed have expired, then remove it from the map.

For automatic runtime invalidation, configure
`ARBITER_CAPABILITY_REVOCATION_ENDPOINTS` with comma-separated gateway
`/v1/capabilities/revoke` URLs plus the matching `ARBITER_SERVICE_SHARED_KEY`.
The control plane persists the revocation before best-effort authenticated
fan-out, and records delivery results in the audit log.
