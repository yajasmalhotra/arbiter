# Versioning

This package follows semantic versioning.

- Patch releases fix behavior without changing configuration or Pi lifecycle contracts.
- Minor releases add backward-compatible configuration or lifecycle support.
- Major releases may change defaults, environment variables, policy payloads, or supported Pi APIs.

## Release checklist

1. Update `package.json` and `CHANGELOG.md`.
2. Run `npm test` and `npm run pack:check`.
3. Run `npm run release:tag -- --dry-run`.
4. Run `npm run release:tag` to push `pi-extension-v<version>` and trigger npm publishing.
