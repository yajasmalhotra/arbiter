# Versioning Policy

`@randromeda/openclaw-arbiter` uses Semantic Versioning (`MAJOR.MINOR.PATCH`).

## Rules

- `MAJOR`: breaking config contract, hook behavior, or install/runtime expectations.
- `MINOR`: backward-compatible features, new guardrail options, new supported tools.
- `PATCH`: backward-compatible bug fixes, policy mapping fixes, docs corrections.

## Stability Notes

- Current status is pre-1.0 (`0.x`), so minor versions may include breaking changes.
- After `1.0.0`, breaking changes move to major version bumps.

## Release Checklist

1. Update package version in `package.json`.
2. Add changelog entry in `CHANGELOG.md`.
3. Run tests:
   - `npm test`
4. Validate package metadata:
   - `npm run pack:check`
