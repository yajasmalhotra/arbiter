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
- Audit read API:
  - `GET /api/audit`
- Dashboard at `/` with policy and audit summaries.

## Local Run

```bash
cd apps/control-plane
npm install
npm run dev
```

Data is persisted in `apps/control-plane/.data/control-plane.json`.
