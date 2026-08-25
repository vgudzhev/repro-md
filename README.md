# repro

Regression tests for AI coding agents — without an API key.

Record a real agent session, replay it offline, assert on what the agent did, and commit the result as a reproducible test case. Works with any agent that talks to the Anthropic Messages API (Claude Code, Aider, custom agents).

> **Status**: v0.1 alpha. Validated against Claude Code. Codex is not currently supported — it uses WebSocket transport exclusively and does not honor `OPENAI_BASE_URL`, making HTTP proxy interception impossible. Other agents that use HTTP-based model APIs (Aider, custom agents) are architecturally supported. If you have a claude.ai subscription, you can test immediately with any Claude model — no API credits needed.

## Table of Contents

- [Why](#why)
- [Install](#install)
- [Step-by-Step Guide](#step-by-step-guide)
- [Use Case: Catching an Agent That Edits Generated Files](#use-case-catching-an-agent-that-edits-generated-files)
- [How It Works](#how-it-works)
- [Verification](#verification)
- [Commands Reference](#commands-reference)
- [Portable Bundles](#portable-bundles)
- [Environment Snapshots](#environment-snapshots)
- [Assertions](#assertions)
- [Replay Modes](#replay-modes)
- [Recording Options](#recording-options)
- [CI Setup](#ci-setup)
- [What Gets Recorded](#what-gets-recorded)
- [Redaction](#redaction)
- [Minimization](#minimization)
- [Fixing a Reproduction](#fixing-a-reproduction)
- [Architecture Decisions](#architecture-decisions)
- [License](#license)

---

## Why

AI coding agents are powerful but unpredictable. When an agent makes a mistake — edits a file it shouldn't, loops on the same tool call, or takes too many API calls to do something simple — you want to:

1. **Capture** the exact failure so you can study it later
2. **Replay** it without spending money on API calls
3. **Assert** that specific bad behaviors happened (or didn't)
4. **Commit** the test so the failure is tracked and reviewable in PRs
5. **Run in CI** without any API keys or network access

repro does all five. Think of it as a VCR for agent sessions — record once, replay forever.

---

## Install

```bash
npm install -g repro-md
```

**Requirements:**
- Node.js 20 or later
- The agent CLI you want to record (e.g. `claude`) must be installed separately — repro spawns it as a child process

**Verify the install:**

```bash
repro --help
```

You should see a list of available commands.

---

## Step-by-Step Guide

### 1. Initialize repro in your project

Navigate to your project's git repository and run:

```bash
cd your-project/
repro init
```

This creates two things:
- `.repro/` directory — where trace data is stored
- `REPRO.md` — a human-readable manifest of known failures (like a bug tracker in your repo)

### 2. Record an agent run

Run your agent through repro's recording proxy:

```bash
repro record -- claude --print "fix the login validation bug"
```

Everything after `--` is the command repro will run. repro starts a local HTTP proxy, points the agent at it, and captures every request and response between the agent and the model API.

When the agent finishes, you'll see output like:

```
repro: recording r-a1b2c3
repro: proxy listening on http://127.0.0.1:52431
repro: completed after 12 events
repro: saved r-a1b2c3
```

The trace is now saved in `.repro/r-a1b2c3/`.

### 3. Replay it (verify it works)

Before saving, verify the recording replays correctly:

```bash
repro run r-a1b2c3
```

This replays the entire agent session using only the recorded data — no network calls, no API key. The agent runs against a git worktree checked out to the same commit, so the filesystem matches the original run.

You should see:

```
repro: replaying r-a1b2c3 (12 events)
repro: mode: strict
repro: reproduced — 12 events, 0 API calls, 0 API keys
```

If it says "diverged," the agent made a different request than what was recorded — this can happen if the agent's behavior depends on something outside the recorded data (timestamps, random values, etc.).

### 4. Save it as a named test

Promote the recording into your project's test manifest:

```bash
repro save r-a1b2c3 --title "agent modifies generated files" \
  --assertion forbidden_path:src/gen/**
```

This does two things:
- Adds the recording to `REPRO.md` with a title and status
- Attaches assertions that will be checked on every replay

### 5. Commit and push

```bash
git add REPRO.md .repro/
git commit -m "add repro: agent modifies generated files"
git push
```

The trace data, manifest, and assertions are all committed to your repo. Anyone who clones the repo can replay the failure.

### 6. Run all tests

```bash
repro test
```

This replays every open failure in `REPRO.md` and exits non-zero if any regression is detected. Run this in CI to catch regressions automatically.

---

## Use Case: Catching an Agent That Edits Generated Files

Here's a concrete scenario. You have a project with auto-generated API types in `src/gen/`. You ask Claude Code to fix a bug, and it edits a generated file instead of the source that generates it. That's a mistake you want to catch and prevent.

**Step 1: Record the bad run**

```bash
repro record -- claude --print "fix the type error in getUserProfile"
```

Claude runs, and you notice it edited `src/gen/api_types.ts` — a file that should never be manually modified.

**Step 2: Save with a forbidden_path assertion**

```bash
repro save r-a1b2c3 \
  --title "agent edits generated API types" \
  --assertion forbidden_path:src/gen/**
```

The `forbidden_path` assertion will fail if any tool call in the trace touches a file matching `src/gen/**`.

**Step 3: Replay to confirm the assertion catches it**

```bash
repro run r-a1b2c3
```

Output:

```
repro: reproduced — 12 events, 0 API calls, 0 API keys
repro: assertion: forbidden_path matched: src/gen/api_types.ts
```

The assertion fires. Now commit it:

```bash
git add REPRO.md .repro/ && git commit -m "repro: agent edits generated files"
```

**Step 4: Run in CI**

Add `repro test` to your CI pipeline. Every push will replay this failure and verify the assertion. If a future agent update stops touching generated files, the assertion will pass — you can close the issue.

**Other assertion examples:**

```bash
# Fail if the agent makes more than 10 API calls
repro save r-xyz --title "agent loops" --assertion max_calls:10

# Fail if the same tool call repeats more than 3 times
repro save r-xyz --title "agent retries excessively" --assertion no_repeat:3

# Run a custom check after replay
repro save r-xyz --title "output file missing" --assertion command:"test -f output.txt"
```

---

## How It Works

repro uses a three-stage pipeline:

### Record

```
Agent  <-->  repro proxy  <-->  Anthropic API
```

An HTTP proxy sits between the agent and the model API. Every request/response pair is captured. Secrets are redacted before anything touches disk. The trace is written to `.repro/<id>/` as a series of JSON events.

### Replay

```
Agent  <-->  repro proxy  (no network)
```

The proxy serves recorded responses instead of forwarding to the real API. The agent runs in an isolated git worktree checked out to the same commit as the original run. Requests are matched by **normalized content hash** — if the agent sends a different request, the mismatch is detected immediately.

Normalization strips volatile fields (timestamps, cache hints, model name, system prompt) so that minor environmental differences don't cause false mismatches.

### Assert

Oracle-free assertions check what the agent did without needing a model to judge correctness. Assertions are evaluated against the trace events and the filesystem state after replay.

---

## Verification

Before replaying a recording, check whether the current environment can actually reproduce it:

```bash
repro verify r-a1b2c3
```

Output for a compatible environment:

```
Reproduction: r-a1b2c3

✓ trace integrity: 12 events valid
✓ metadata integrity: meta.json valid
✓ required blobs: 3 blob(s) present
✓ git commit available: a1b2c3d4e5
✓ repository state: clean working tree
✓ runtime version: Node 22.4.0 compatible
✓ lockfile hash: package-lock.json matches
⚠ agent version: recorded 1.0.18, current 1.0.22
✓ model responses recorded: 4 response(s) available for replay
✓ replay prerequisites: 4 complete exchange(s)
✓ worktree support: git worktree available

Result: REPLAYABLE WITH WARNINGS
```

For a genuinely incompatible environment:

```
✗ runtime version: Node 18.0.0 required, Node 22.4.0 detected
✗ required blobs: 2 blob(s) missing: a1b2c3d4e5f6…

Result: NOT REPLAYABLE
```

### Three dimensions

`repro verify` separates three questions:

1. **Can replay?** — Are all hard prerequisites met (trace intact, blobs present, commit available, binary installed)?
2. **Is this environment identical?** — Do platform, runtime version, lockfile, and other environment details match the recording?
3. **Is this reproduction trustworthy?** — Are there any warnings or unknowns that could affect reliability?

Environmental differences (different minor Node version, different OS) produce warnings, not failures. Only genuinely blocking issues (missing blobs, wrong major runtime version, missing binary) produce failures.

### Machine-readable output

```bash
repro verify r-a1b2c3 --json
```

Returns a JSON object with `id`, `verdict`, `canReplay`, `environmentIdentical`, `trustworthy`, and a `checks` array where each check has `name`, `status` (PASS/WARN/FAIL/UNKNOWN), `message`, and `category`.

### Check categories

| Category | Checks |
|---|---|
| `trace` | Trace integrity, metadata integrity, required blobs |
| `environment` | Git commit, repository state, platform, architecture, lockfile hash, required files |
| `runtime` | Runtime version, package manager |
| `replay` | Agent binary, agent version, model responses, replay prerequisites, worktree support |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Replayable (with or without warnings) |
| `1` | Not replayable (at least one FAIL check) |

---

## Commands Reference

| Command | Description |
|---|---|
| `repro init` | Create `.repro/` and `REPRO.md` in the current repo |
| `repro record [options] -- <cmd>` | Record an agent run through the proxy |
| `repro run <id> [--lenient]` | Replay a recorded run (strict by default) |
| `repro save <id> --title '...'` | Promote a recording into `REPRO.md` |
| `repro test` | Replay all open failures, exit 1 on regression |
| `repro list` | List all recordings with dates and status |
| `repro inspect <id> [--json]` | Show a trace timeline in the terminal |
| `repro diff <a> <b> [--json]` | Align and compare two traces side by side |
| `repro explain <a> <b>` | Report the first divergence and downstream effects |
| `repro minimize <id> --budget <n>` | Delta-debug inputs to find a minimal reproducing set |
| `repro export <id> [--check] [-o path]` | Export a portable bundle |
| `repro import <bundle>` | Import a bundle into the current repo |
| `repro verify <id> [--json]` | Verify replayability of a recording |
| `repro snapshot [--json]` | Capture and display an environment snapshot |
| `repro fix <id> [--max-attempts N] [--agent name]` | Fix a reproduction with a coding agent, verified by `repro test` |

---

## Portable Bundles

Share reproductions across machines, repositories, and CI systems.

### Export

```bash
repro export r-abc123
```

Creates `repro-r-abc123.repro` — a portable, integrity-checked bundle containing the trace, assertions, blobs, and metadata. Machine-specific paths are sanitized.

**Security check** (dry run, no file created):

```bash
repro export r-abc123 --check
```

Scans for unredacted secrets, absolute paths, and other sensitive content. Exits non-zero if high-severity findings are detected.

**Custom output path:**

```bash
repro export r-abc123 -o /tmp/bug-report.repro
```

### Import

```bash
repro import repro-r-abc123.repro
```

Validates the bundle (version, checksums, blob integrity, security), then writes it to `.repro/<id>/`. If an ID collision occurs, a new ID is generated automatically.

After importing, use the standard commands:

```bash
repro run <id>           # replay the imported trace
repro save <id> --title  # add to REPRO.md
repro test               # include in CI test suite
```

### Bundle Format

Bundles are gzip-compressed JSON with SHA-256 integrity checking. The format is versioned and designed for interoperability — see [`docs/bundle-format.md`](docs/bundle-format.md) for the full specification.

---

## Environment Snapshots

Every `repro record` automatically captures an environment snapshot alongside the trace. The snapshot records the repository state, platform, runtimes, lockfile hashes, and agent information — everything needed to answer "what environment did this failure happen in?" without exposing secrets.

You can also capture a snapshot independently:

```bash
repro snapshot
```

Output:

```
Repository
  commit:   8f21c9d
  branch:   main
  dirty:    yes
  changed:  3 file(s)

Environment
  platform: linux-x64
  node: 22.4.0
  npm: 10.8.0
  pkg-mgr:  npm 10.8.0
  package-lock.json: sha256:a1b2c3d...

Agent
  claude-code: 2.4.1
  model:    claude-sonnet-4-20250514

Workdir
  relative: .
```

Use `--json` for machine-readable output. Use `--output <dir>` to write `snapshot.json` to a directory.

The snapshot is stored as `.repro/<id>/snapshot.json` alongside `meta.json` and `trace.json`. It is backward compatible — existing traces without a snapshot continue to work. The snapshot format is versioned (`formatVersion`) for future evolution.

**What is captured:**
- Git: repository root, commit SHA, branch, dirty status, dirty diff (stat), safe untracked files
- Platform: OS, architecture, kernel release
- Runtimes: Node.js, npm, Python, Go, Rust (where available)
- Package manager and version
- Lockfile content hashes (SHA-256)
- Agent name, version, and model (where available)
- Working directory relative to repository root
- Non-secret environment variable names (never values)

**What is NOT captured:**
- Environment variable values (only names, filtered for safety)
- Files matching secret patterns (`.env`, `*.pem`, `*.key`, etc.)
- Untracked files with sensitive-looking names

---

## Assertions

Attach assertions when saving a recording. They are checked on every `repro run` and `repro test`.

```bash
repro save r-abc123 --title "description" \
  --assertion forbidden_path:src/gen/** \
  --assertion max_calls:5 \
  --assertion no_repeat:2 \
  --assertion command:"test -f output.txt"
```

| Type | What it checks |
|---|---|
| `forbidden_path:<glob>` | Fails if any tool call touches a path matching the glob |
| `no_repeat:<n>` | Fails if the same tool call (name + args) repeats more than n times |
| `max_calls:<n>` | Fails if total model API calls exceed n |
| `command:<cmd>` | Runs a shell command in the worktree after replay; non-zero = failure |

---

## Replay Modes

- **Strict** (default for `repro test`): Requests are matched by normalized content hash. If the agent sends a request that doesn't match any recorded hash, replay aborts and reports which message diverged.

- **Lenient** (`--lenient`): On a hash miss, falls back to positional matching (use the next recorded response in sequence). Warns on every fallback. Useful during development when you expect minor differences.

---

## Recording Options

Control how the agent is configured during recording:

```bash
# Specify which model to use
repro record --model claude-sonnet-4 -- claude --print "fix the bug"

# Use your claude.ai subscription (no API key)
repro record --auth plan -- claude --print "fix the bug"

# Use API credits (requires ANTHROPIC_API_KEY)
repro record --auth credits -- claude --print "fix the bug"

# Combine both
repro record --model claude-opus-4 --auth plan -- claude --print "fix the bug"
```

| Flag | Description |
|---|---|
| `--model <name>` | Passed to the agent CLI and stored in the trace metadata |
| `--auth plan` | Uses your claude.ai subscription; removes API key from the agent's environment |
| `--auth credits` | Uses API key auth; requires `ANTHROPIC_API_KEY` to be set |

These flags go **before** the `--` separator. Everything after `--` is the agent command.

---

## CI Setup

No API key is needed for replay. The agent binary must be available on the CI runner.

```yaml
# .github/workflows/repro.yml
name: Repro Tests
on: [push, pull_request]
jobs:
  repro-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      # Install the agent CLI used in your recordings
      - run: npm install -g @anthropic-ai/claude-code
      - run: npx repro test
```

`repro test` exits with code 0 if all replays pass, code 1 if any fail or diverge. Standard CI behavior.

---

## What Gets Recorded

The proxy captures the full Anthropic Messages API conversation:
- Every model request (prompts, tool results, context)
- Every model response (text, tool calls, thinking blocks)
- Streaming responses are reassembled on capture and re-chunked on replay

**What is NOT captured** (in v0.1):
- Filesystem changes as observed on disk
- Subprocess output from tools
- Network calls made by tools

Side effects are recorded as reported by the agent in API messages, not as observed on disk. This is a known limitation.

---

## Redaction

Secrets are redacted at capture time, before anything touches disk:

- **Environment variables**: Non-standard env var values are replaced with `[[redacted:env:<hash>]]`
- **Known patterns**: API keys (`sk-ant-*`, `sk-*`, `ghp_*`, `AKIA*`), JWTs, and PEM blocks are scrubbed
- **Headers**: `Authorization` and `x-api-key` headers are stripped
- **Files**: Content from `.env*`, `*.pem`, `*.key`, `**/secrets/**` paths is redacted

Common non-secret env vars (`PWD`, `HOME`, `PATH`, `SHELL`, `TERM`, `EDITOR`, etc.) are excluded from redaction — redacting them corrupts file paths in response bodies and breaks replay. The full allowlist is in `src/redact.ts`.

---

## Minimization

When you have a failing trace, you can find the minimum inputs needed to reproduce it:

```bash
repro minimize r-abc123 --inputs context,files,tools --budget 5.00
```

This uses the ddmin algorithm to systematically remove inputs (context messages, tool definitions, file contents) and re-run the agent with live model calls, finding the smallest set that still triggers the failure.

**This costs money** — it makes real API calls. The `--budget` flag caps your spend.

| Flag | Default | Description |
|---|---|---|
| `--budget <n>` | required | Maximum spend in dollars |
| `--inputs <types>` | `context,files,tools` | Which input types to try removing |
| `--k <n>` | `3` | Samples per candidate (higher = more reliable, more expensive) |
| `--m <n>` | `2` | Minimum successes to accept a candidate |

The output reports a "minimal reproducing set" — never "cause." A minimal sufficient input is not a causal explanation.

---

## Fixing a Reproduction

`repro fix` closes the loop: failure → reproduction → diagnosis → fix → verification → regression test. **repro owns the reproduction and verification loop; the coding agent only proposes changes.**

```bash
repro fix r-a1b2c3
```

What happens:

1. `repro verify`s the reproduction — aborts if it isn't replayable.
2. Creates an isolated git worktree at the recorded commit (your working tree is never touched).
3. Replays the reproduction there to confirm it currently fails (the baseline). If it doesn't fail, `repro fix` aborts — there's nothing to fix.
4. Hands a compact failure brief to a coding agent (Claude Code by default) working inside the worktree.
5. Re-runs the reproduction. If `repro test <id>` would now pass, the fix is verified. Otherwise, it tries again — up to `--max-attempts` (default 3).

```
repro: fix r-a1b2c3
repro: verifying reproduction and confirming baseline failure...
repro: ✓ baseline confirmed failing
repro: attempt 1/3 — ✗ assertion still failing (agent exit 0, 1 file(s) changed)
repro: attempt 2/3 — ✓ assertion passed (agent exit 0, 1 file(s) changed)

Fix verified.

Reproduction: r-a1b2c3
Attempts: 2
Changed files: 1
Diff: +3 / -1
Assertion: ✓ command
Worktree: /tmp/repro-worktree-xyz
```

Nothing is committed automatically. The worktree is always left behind — verified or not — so you can inspect the diff and decide whether to apply it:

```bash
cd /tmp/repro-worktree-xyz && git diff
```

**Options:**

| Flag | Default | Description |
|---|---|---|
| `--max-attempts <n>` | `3` | How many times to retry the agent before giving up |
| `--agent <name>` | `claude-code` | Which coding agent to use (only `claude-code` is currently supported) |

**What makes an assertion fixable:** `command` assertions run a shell command against the worktree's actual state after replay — a code change can affect their outcome. `forbidden_path`, `no_repeat`, and `max_calls` are evaluated against the recorded trace itself, which replay serves byte-for-byte regardless of any code change. If a reproduction fails only on those, `repro fix` says so and doesn't burn attempts on a target it can't move — see [ADR-028](docs/decisions/028-fix-loop-and-agent-runner.md).

**Storage:** each attempt is recorded under `.repro/<id>/fixes/<fix-id>/session.json` and `attempts.json` — reproduction ID, worktree path, agent, per-attempt result, changed files, and timestamps.

---

## Architecture Decisions

Design decisions are recorded in `docs/decisions/`. Key ones:

| ADR | Decision |
|---|---|
| D-004 | Request matching by normalized hash, not sequence number |
| D-006 | Replay in isolated git worktree |
| D-007 | Redaction at capture time, never at read time |
| D-011 | Oracle-free assertions only in v0.1 |
| D-020 | Hash raw request body before redaction |
| D-021 | Strip system prompt and `<system-reminder>` noise from hash |
| D-027 | Environment snapshots as separate artifact |
| D-028 | `repro fix` — bounded fix loop, pluggable AgentRunner, `repro test` is the only success signal |

---

## License

MIT
