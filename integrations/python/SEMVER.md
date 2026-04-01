# Versioning Policy

`arbiter-integrations` uses Semantic Versioning (`MAJOR.MINOR.PATCH`).

## Rules

- `MAJOR`: breaking API or behavior changes.
- `MINOR`: backward-compatible features, new wrappers, optional parameters.
- `PATCH`: backward-compatible bug fixes and documentation corrections.

## Stability Notes

- Current status is pre-1.0 (`0.x`), so minor versions may include breaking changes.
- Once `1.0.0` is released, breaking changes will move to major version bumps only.

## Release Checklist

1. Update `pyproject.toml` version.
2. Add changelog entry in `CHANGELOG.md`.
3. Run tests:
   - `python3 -m unittest discover integrations/python/tests -v`
4. Build package artifacts:
   - `python3 -m pip install build`
   - `python3 -m build integrations/python`
