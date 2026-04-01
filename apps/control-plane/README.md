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

Production channel safeguards:

- `POST /api/bundles/:id/promote` with `channel=prod` creates a pending approval request.
- `POST /api/bundles/channels/prod/rollback` creates a pending approval request.
- Direct prod activation/rollback is blocked until an approver executes `/api/approvals/:id/approve`.

Bundle artifact endpoints require `Authorization: Bearer <token>` and validate against `ARBITER_BUNDLE_SERVICE_TOKEN`/`ARBITER_BUNDLE_SERVICE_TOKEN_SCOPES`.
Published bundle archives include `.signatures.json` and are signed by the active signing key.
In Postgres mode, manage keys with the signing-key APIs; in fallback mode, signing uses:

- `ARBITER_BUNDLE_SIGNING_KEY_ID`
- `ARBITER_BUNDLE_SIGNING_SCOPE`
- `ARBITER_BUNDLE_SIGNING_SECRET`
