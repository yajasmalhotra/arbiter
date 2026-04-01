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
  - `GET /api/bundles/activations`
- Revision APIs:
  - `GET /api/revisions`
- Audit read API:
  - `GET /api/audit`
- Policy test proxy (calls a running Arbiter interceptor):
  - `POST /api/policies/:id/test` — body: `{ interceptPath?, payload, arbiterBaseUrl? }`. Server uses `ARBITER_URL` (default `http://127.0.0.1:8080`) unless `arbiterBaseUrl` is set.
- Dashboard at `/` with **AG Grid** policy table, summary pills, and recent audit events.
- Policy detail at `/policies/:id`: view/edit fields and **Test against Arbiter** (edit JSON body, pick intercept route, run).
- **Create Policy** at `/policies/new` (sidebar + empty grid CTA). Sidebar: **Dashboard**, **Create Policy**.
- UI uses **shadcn/ui** (Tailwind CSS, Radix primitives) and **AG Grid** for the policy table.

## Local Run

```bash
cd apps/control-plane
npm install
npm run dev
```

Data is persisted in `apps/control-plane/.data/control-plane.json`.

If `CONTROL_PLANE_API_KEY` is set, mutating APIs require header `X-Arbiter-Control-Key`.
