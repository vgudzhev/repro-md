# D-027: Environment snapshots as separate artifact

## Status

Accepted

## Context

Recorded traces capture what the model did (requests/responses) and basic metadata (commit, command, timestamps). But when triaging a failure, you also need to know the environment: what platform, what runtime versions, what dependency versions, whether the worktree was dirty.

This information is needed to answer: "Can I reproduce this failure in my environment, and if not, what's different?"

## Decision

Introduce a first-class `EnvironmentSnapshot` captured at record time and stored as `snapshot.json` alongside `meta.json` and `trace.json` in the trace directory.

### Why a separate file

1. **Backward compatibility**: existing traces without a snapshot continue to work. `readSnapshot()` returns `null` for old traces.
2. **Separation of concerns**: `meta.json` describes the recording session. `snapshot.json` describes the environment. These are orthogonal.
3. **Size**: the snapshot is self-contained and small (typically < 5KB). It doesn't bloat the trace or meta files.
4. **Versioning**: the snapshot has its own `formatVersion` field, independent of the trace format.

### What is captured

- **Repository**: git root, commit SHA, branch, dirty status, dirty diff (stat only, not full patch), safe untracked files
- **Platform**: OS, architecture, kernel release
- **Runtimes**: Node.js, npm, Python, Go, Rust — detected by running `<cmd> --version`
- **Package manager**: detected from lockfile presence (package-lock.json → npm, yarn.lock → yarn, etc.)
- **Lockfile hashes**: SHA-256 of each lockfile's content — deterministic, small, and useful for `repro verify`
- **Agent**: name, version, model — from CLI options or auto-detection
- **Working directory**: absolute path and relative-to-repo path
- **Environment variable names**: filtered to exclude secret-sounding names, never values

### What is NOT captured

- Environment variable **values** (only names) — reuses the project's existing security posture
- Full git diffs (only `--stat` summary) — keeps snapshots small
- Untracked files with sensitive-looking names (.env, *.pem, *secret*, etc.)

### Security model

The snapshot follows the same principles as the existing redaction engine (D-007):
- No secret values touch disk
- File paths are filtered against known sensitive patterns
- Environment variable names are filtered against secret-related prefixes (SECRET, PASSWORD, TOKEN, KEY, CREDENTIAL, AUTH, PRIVATE)

## Consequences

- Every `repro record` now writes a `snapshot.json` — negligible overhead (< 100ms for git + runtime detection)
- `repro snapshot` provides standalone environment inspection without recording
- Future `repro verify` can compare snapshots to detect environment drift
- The snapshot format is versioned for safe evolution
