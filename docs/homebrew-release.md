# Homebrew Release Automation

Arbiter release automation publishes cross-platform CLI artifacts and updates a Homebrew tap formula.

## Workflow

- Workflow: `.github/workflows/arbiter-release.yml`
- Tag trigger: `arbiter-v*` (for example `arbiter-v0.2.0`)
- Manual trigger: `workflow_dispatch` with `version` input

On each run:

1. Runs `go test ./...`
2. Builds archives for:
   - `darwin/amd64`
   - `darwin/arm64`
   - `linux/amd64`
   - `linux/arm64`
3. Publishes GitHub Release assets:
   - `arbiter_<version>_<os>_<arch>.tar.gz`
   - `checksums.txt`
4. Optionally updates `Formula/arbiter.rb` in a Homebrew tap repository.

## Required Configuration

- `HOMEBREW_TAP_TOKEN` (repository secret):
  - GitHub token with write access to the tap repository.
- `HOMEBREW_TAP_REPO` (repository variable, optional):
  - Format: `<owner>/<repo>`
  - Default: `yajasmalhotra/homebrew-tap`

## Local Preview

Build artifacts:

```bash
./tools/release/build_arbiter_artifacts.sh 0.2.0
```

Render formula:

```bash
./tools/release/render_homebrew_formula.sh \
  0.2.0 \
  yajasmalhotra/arbiter \
  dist/checksums.txt \
  /tmp/arbiter.rb
```

