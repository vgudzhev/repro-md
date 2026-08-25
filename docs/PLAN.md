# repro — Implementation Plan

Source of truth for progress. Updated as work completes.

## Phase 0 — Decisions and skeleton

- [x] P0-1: Write ADRs for locked decisions D-001 through D-012
- [x] P0-2: Resolve open questions §9 Q1–Q6 as ADRs 013–018
- [x] P0-3: Write ADR-019 recording competitive prior art review (§10)
- [x] P0-4: Commit project brief as `docs/BRIEF.md`
- [x] P0-5: Repo skeleton — `package.json`, `tsconfig.json`, eslint, vitest, `.gitignore`
- [x] P0-6: CI workflow — `.github/workflows/ci.yml` with build, lint, test
- [x] P0-7: Verify `npm run build && npm run lint && npm test` all pass
- [x] P0-8: Write this plan (`docs/PLAN.md`)

**Gate:** all checkboxes above checked, build/lint/test green.

---

## Phase 1 — Recording

### Test fixtures (build first — everything else is tested through these)

- [x] P1-1: **Stub upstream server.** A local HTTP server that returns canned Anthropic Messages API responses. Must support:
  - Non-streaming: returns a complete `message` response with tool-use content blocks
  - Streaming: returns SSE stream (`message_start`, `content_block_start`, `content_block_delta`, `message_delta`, `message_stop`)
  - Configurable response sequences (serve response N for request N)
  - Runs on an ephemeral port, returns the port to the caller

- [x] P1-2: **Reference agent.** A ~100-line Node script that:
  - Reads `ANTHROPIC_BASE_URL` from env (falls back to `https://api.anthropic.com`)
  - Sends Messages API requests with `tools` definitions for `read_file` and `write_file`
  - Executes tool calls from the model response against the real filesystem
  - Sends tool results back in the next request
  - Loops until the model returns `end_turn` stop reason
  - Exits 0 on success, 1 on failure

### Core proxy and recording

- [x] P1-3: **HTTP proxy server.** Listens on `127.0.0.1:<port>`, forwards to the upstream API.
  - Intercepts POST `/v1/messages` (Anthropic Messages API)
  - Passes all other paths through unmodified
  - Returns the upstream response verbatim to the client
  - Handles both non-streaming and streaming (`stream: true`) requests
  - Assigns monotonic `seq` to each request/response pair

- [x] P1-4: **SSE reassembly.** Streaming responses are reassembled into a complete message object before storage. On replay, the stored message is re-chunked into SSE events for the client.
  - Acceptance: a streaming request through the proxy produces the same final message as a non-streaming request with the same content

- [x] P1-5: **Trace writer.** Writes events to `.repro/<id>/trace.json` as a flat append-only log (D-008).
  - Event types for Phase 1: `model.request`, `model.response`, `process.start`, `process.exit`
  - Each event has `seq`, `type`, `timestamp`, and `data`
  - `data` is inline for small payloads, `blob:sha256-<hex>` for large ones (D-009)
  - Blob threshold: configurable, default 10 KB
  - Writes `.repro/<id>/meta.json` with recording metadata (id, command, start time, end time, event count)

- [x] P1-6: **Request normalization.** Normalize API requests for hash-based matching (D-004).
  - Strip volatile fields: request ids, timestamps, `cache_control` breakpoints (D-017)
  - Canonicalize JSON key ordering (sorted keys, deterministic serialization)
  - Compute SHA-256 hash of the normalized full message array
  - Compute per-message hash chain: `hash[i] = SHA-256(hash[i-1] || message[i])`
  - Store both hashes with each `model.request` event
  - The volatile-fields exclusion list is defined once, used by both normalization and matching

- [x] P1-7: **Redaction engine (D-007).** Applied in the proxy before any data touches disk.
  - Rule 1: env var values never captured — scan request/response bodies for known env var values from the process environment, replace with `[[redacted:env:<sha256-prefix-8>]]`
  - Rule 2: known secret patterns — `sk-ant-`, `sk-`, `ghp_`, `ghu_`, `AKIA`, JWT (`eyJ...`), PEM blocks, `Authorization` header values. Replace with `[[redacted:pattern:<rule-name>:<sha256-prefix-8>]]`
  - Rule 3: path denylist — content from `.env*`, `*.pem`, `*.key`, `**/secrets/**` paths appearing in tool results. Replace with `[[redacted:path:<sha256-prefix-8>]]`
  - Rule 4: every redaction marker includes a SHA-256 prefix of the original value for detection of the same secret elsewhere
  - Configurable via `.repro/redact.json` (allow overrides, additional patterns)

- [x] P1-8: **`repro record` CLI command.** Orchestrates the recording flow:
  - Parses `repro record -- <cmd> [args...]`
  - Generates trace id (`r-<6 hex>`, ADR-018)
  - Starts the proxy on an ephemeral port
  - Sets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` in the child environment
  - Sets `ANTHROPIC_API_KEY=sk-repro-dummy` if not already set (agents that check at startup)
  - Spawns the child process
  - On child exit: finalizes the trace, writes `meta.json`, prints summary
  - Acceptance: `repro record -- node reference-agent.js` produces a complete trace under `.repro/<id>/`

### Phase 1 tests

- [x] P1-T1: **Redaction test.** Inject a fake secret (`sk-ant-fake-secret-key-12345`) into a request body via the reference agent. Assert it appears nowhere under `.repro/` — not in `trace.json`, not in any blob file. Assert the `[[redacted:...]]` marker is present instead.

- [x] P1-T2: **Full record loop.** Reference agent + stub upstream → complete ordered trace.
  - Assert `trace.json` contains the expected event sequence: `process.start`, then alternating `model.request`/`model.response`, then `process.exit`
  - Assert monotonic `seq` numbering
  - Assert blob references resolve to existing files
  - Assert no network access needed (stub is localhost)

- [x] P1-T3: **Streaming reassembly.** Record a streaming response through the proxy. Assert the stored `model.response` event contains the fully reassembled message, not raw SSE chunks.

- [x] P1-T4: **Blob threshold.** Send a request with a payload exceeding the blob threshold. Assert the trace contains a `blob:sha256-...` reference and the blob file exists under `.repro/<id>/blobs/`.

**Phase 1 gate:** all tests pass, `npm test` green, no network access required.  
**Manual gate passed 2026-08-15:** reference agent ran to completion through the proxy against the real Anthropic API with no behavioural difference (both streaming and non-streaming).

---

## Phase 2 — Replay

- [x] P2-1: **Replay proxy mode.** The proxy serves recorded responses instead of forwarding.
  - Load the trace and index all `model.response` events by the normalized request hash of their corresponding `model.request`
  - On incoming request: normalize, hash, look up in the index
  - Hit → serve the recorded response
  - Miss → behaviour depends on mode (see P2-2)
  - Resolve blob references when serving responses

- [x] P2-2: **Strict and lenient modes (D-004).**
  - `--strict` (default for `repro test`): on hash miss, abort immediately. Report: the seq number of the diverging request, the per-message hash chain showing which message diverged, a diff of the expected vs. actual message at the divergence point.
  - `--lenient`: on hash miss, fall back to positional matching (serve response N for request N). Warn on every fallback. Mark the trace metadata as `diverged: true`.

- [x] P2-3: **Streaming re-chunking.** When serving a recorded response and the original request had `stream: true`:
  - Re-chunk the stored complete message into SSE events matching the Anthropic streaming format
  - Deliver with realistic inter-chunk delays (configurable, default: no delay for tests, ~10ms for interactive use)
  - Acceptance: a streaming client receives a valid SSE stream that assembles to the stored message

- [x] P2-4: **Git worktree isolation (D-006).**
  - Before replay: create a fresh `git worktree` in a temp directory, checked out at the same commit as the recording
  - Run the agent process inside the worktree
  - After replay (success or failure): remove the worktree with `git worktree remove --force`
  - Cleanup must be robust: use try/finally, handle agent crashes, handle signals (SIGINT, SIGTERM)
  - Record the worktree commit and path in the replay metadata

- [x] P2-5: **`repro run` CLI command.** Orchestrates the replay flow:
  - Parses `repro run <id> [--strict|--lenient]`
  - Loads the trace from `.repro/<id>/`
  - Creates worktree (P2-4)
  - Starts the proxy in replay mode (P2-1)
  - Spawns the agent in the worktree with `ANTHROPIC_BASE_URL` pointed at the replay proxy
  - On completion: reports event count, divergences (if any), assertion results (Phase 3)
  - Tears down worktree
  - Exits 0 if no divergences in strict mode, 1 if diverged

### Phase 2 tests

- [x] P2-T1: **Clean git status.** Record with reference agent + stub, replay, assert `git status --porcelain` output is empty after replay.

- [x] P2-T2: **Strict-mode divergence detection.** Record a trace. Replay with a mutated reference agent that sends a different tool result for one call. Assert strict mode aborts, reports the correct diverging message index, and includes a meaningful diff.

- [x] P2-T3: **Lenient-mode fallback.** Same setup as P2-T2 but with `--lenient`. Assert the replay completes, the response is served positionally, and the trace is marked `diverged`.

- [x] P2-T4: **Streaming replay.** Record a streaming interaction. Replay it. Assert the agent receives valid SSE events and the final assembled message matches the recording.

- [x] P2-T5: **Worktree cleanup on crash.** Simulate an agent crash (reference agent exits with code 1 mid-run). Assert the worktree is cleaned up and `git status` is clean.

**Phase 2 gate:** all tests pass.  
**THE GATE passed 2026-08-15:** recorded real agent runs (streaming + non-streaming) against live Anthropic API, replayed in strict mode with 0 API calls and 0 API keys, obtained identical observable event sequences.

---

## Phase 3 — Assertions, manifest, CI

- [x] P3-1: **Assertion engine.** Reads `.repro/<id>/assertions.json`, evaluates each assertion against the trace and the worktree state after replay.
  - `forbidden_path`: fail if any `tool.call` or `tool.result` event references a path matching the glob pattern. Checked against the trace, not the filesystem.
  - `no_repeat`: fail if the same tool call (same name + same normalized args) appears more than N times.
  - `max_calls`: fail if total `model.request` event count exceeds N.
  - `command`: run a shell command in the worktree after replay; non-zero exit = failure. Stdout/stderr captured in the assertion result.

- [x] P3-2: **`repro init` command.** Scaffolds the repro structure in the current repo:
  - Creates `.repro/` directory
  - Creates `REPRO.md` with header and empty table
  - Adds `.repro/*/blobs/` to `.gitignore` if not present
  - Prints instructions for first use

- [x] P3-3: **`repro save` command.** Promotes a recording into the manifest:
  - `repro save <id> --title "description" [--assertion forbidden_path:src/gen/**]`
  - Adds a row to `REPRO.md`: `| <id> | <title> | open | <date> |`
  - Writes/updates `.repro/<id>/assertions.json`
  - Validates the recording exists and is complete

- [x] P3-4: **`repro test` command.** CI entry point:
  - Reads `REPRO.md` to find all entries with status `open`
  - For each: replays in `--strict` mode, evaluates assertions
  - Reports results per trace: pass/fail/diverged
  - Exits 0 if all pass, 1 if any fail or diverge
  - Prints summary: `✓ N passed, ✗ M failed, ⚠ K diverged`
  - Needs no API key — all responses are from recordings

- [x] P3-5: **`repro list` command.** Lists all recordings in `.repro/`:
  - Shows: id, date, event count, command, status (from REPRO.md if saved)
  - Sorted by date, newest first

- [x] P3-6: **`repro inspect` command.** Renders a trace readably:
  - `repro inspect <id>` shows the event timeline with abbreviated payloads
  - Shows tool call names, file paths touched, model call count
  - Colorized terminal output
  - `--json` flag for machine-readable output

- [x] P3-7: **GitHub Action example.** A `.github/workflows/repro.yml` example that runs `repro test` with no API key configured. Document in README.

### Phase 3 tests

- [x] P3-T1: **Assertion fires.** Record a trace where the reference agent writes to `src/gen/output.txt`. Add a `forbidden_path: src/gen/**` assertion. Assert the assertion fails with the correct path.

- [x] P3-T2: **Assertion passes.** Same trace, assertion `forbidden_path: nonexistent/**`. Assert it passes.

- [x] P3-T3: **no_repeat assertion.** Record a trace where the reference agent makes 3 identical tool calls. Assert `no_repeat` with max 2 fires; with max 5 passes.

- [x] P3-T4: **max_calls assertion.** Assert `max_calls: 1` fires on a trace with 3 model calls; `max_calls: 10` passes.

- [x] P3-T5: **command assertion.** Assert a `command: "test -f output.txt"` assertion passes when the file exists in the worktree after replay, fails when it doesn't.

- [x] P3-T6: **Full loop.** `repro record` → `repro save` → `repro test` on the reference agent. Assert exit code 0. Then add a failing assertion and assert exit code 1.

**Phase 3 gate:** all tests pass. The full record-save-test loop works end to end on the reference agent with no network access and no API key.

---

## Phase 4 — Diff and explain

- [x] P4-1: **Trace alignment.** Align two traces using LCS (Longest Common Subsequence) over canonical event keys (`type + normalized-hash` for model events, `type + tool-name` for tool events).
  - Handle sequences of different lengths (this is alignment, not zip)
  - Output: aligned event pairs with match/mismatch/insert/delete annotations

- [x] P4-2: **Divergence classification.** Classify each non-matching alignment position:
  - `args_changed`: same tool, different arguments
  - `tool_changed`: different tool at the same logical position
  - `event_inserted`: event present in one trace but not the other
  - `event_dropped`: event present in one trace but not the other (reverse direction)
  - `result_changed`: same tool and args, different result

- [x] P4-3: **`repro diff` command.**
  - `repro diff <a> <b>` prints the alignment with divergences highlighted
  - Color-coded: green for matching, red for divergence, yellow for inserts/drops
  - Shows event type, tool name, and abbreviated args for each position
  - `--json` for machine-readable output

- [x] P4-4: **`repro explain` command.**
  - Reports the first divergence point, the diverging message content, and which downstream events changed as a consequence
  - No LLM involved — purely structural analysis
  - If the first event is `result_changed`, report as environment drift: "the first tool result differs from the recording — this usually means the environment has changed since recording. Consider re-recording."

### Phase 4 tests

- [x] P4-T1: **Identical traces align perfectly.** Diff a trace against itself, assert zero divergences.

- [x] P4-T2: **Known divergence detected.** Create two traces that differ at a known point. Assert `diff` identifies the correct position and classification.

- [x] P4-T3: **Environment drift message.** Create two traces where the first `tool.result` differs. Assert `explain` produces the environment drift advice.

**Phase 4 gate:** all tests pass.

---

## Phase 5 — Minimize

- [x] P5-1: **ddmin implementation.** Delta debugging over input sets (context files, prompt sections, tool definitions).
  - Standard ddmin algorithm: binary partition, reduce, recurse
  - Input: a set of items to minimize, an oracle function, budget
  - Output: a minimal subset where the oracle still fires

- [x] P5-2: **Stochastic oracle.** Run each candidate k times (default 3), accept at ≥m (default 2).
  - Configurable k and m
  - Pin `temperature: 0` and seed where the provider supports it
  - Each oracle call is a live `reinfer` mode run (real model calls)

- [x] P5-3: **Budget management.** Track spend per oracle call.
  - Hard cap in dollars (required argument: `--budget <n>`)
  - Abort cleanly when budget is reached, report the best result so far
  - Refuse to run if recorded reproduction rate is below ~0.3

- [x] P5-4: **`repro minimize` command.**
  - `repro minimize <id> --inputs context,files,tools --budget <n>`
  - Reports: original input count, minimal input count, reproduction rate, spend
  - Never uses the word "cause" — "minimal reproducing set" only
  - `--k` and `--m` flags for oracle configuration

### Phase 5 tests

- [x] P5-T1: **ddmin correctness.** Unit test ddmin with a deterministic oracle over a known minimal subset. Assert it finds the correct minimum.

- [x] P5-T2: **Budget enforcement.** Mock the oracle to always cost $0.10. Set budget to $0.25. Assert it stops after 2 calls and reports partial results.

- [x] P5-T3: **Low reproduction rate rejection.** Set reproduction rate to 0.1. Assert `minimize` refuses to run with an explanatory message.

**Phase 5 gate:** all tests pass. Manual validation passed 2026-08-15: live minimize ran against real Anthropic API with `max_calls` and `forbidden_path` assertions, ddmin correctly reduced input sets, total spend $0.03.

---

## Phase 6 — Environment Snapshots (Phase 1)

- [x] P6-1: **EnvironmentSnapshot type and capture.** First-class snapshot concept in `src/snapshot.ts`:
  - Git: repository root, commit SHA, branch, dirty status, dirty file count, dirty diff (stat), safe untracked files
  - Platform: OS, architecture, kernel release
  - Runtimes: Node.js, npm, Python, Go, Rust (detected via `--version`)
  - Package manager detection from lockfile presence
  - Lockfile SHA-256 hashes (deterministic, content-addressed)
  - Agent name, version, model (from options or auto-detection)
  - Working directory (absolute and relative to repo root)
  - Non-secret environment variable names (values never captured)
  - Format version for backward-compatible evolution
  - Timestamp

- [x] P6-2: **`repro snapshot` CLI command.** Standalone environment inspection:
  - Human-readable summary output (repository, environment, agent, workdir sections)
  - `--json` flag for machine-readable output
  - `--output <dir>` to write `snapshot.json` to a directory

- [x] P6-3: **Integration with `repro record`.** Snapshot captured automatically after recording completes, stored as `.repro/<id>/snapshot.json`.

- [x] P6-4: **Security model.** Follows existing redaction principles (D-007):
  - No environment variable values captured
  - Untracked files filtered against sensitive patterns (.env, *.pem, *.key, *secret*, etc.)
  - Environment variable names filtered against secret-related prefixes

- [x] P6-5: **ADR-027.** Decision record for environment snapshots as separate artifact.

### Phase 6 tests

- [x] P6-T1: **Clean repository snapshot.** Capture snapshot from clean git repo, verify commit SHA format, dirty=false, all required fields present.

- [x] P6-T2: **Dirty repository snapshot.** Capture from dirty repo, verify dirty=true, dirtyFileCount > 0, dirtyDiff contains changed filenames.

- [x] P6-T3: **Lockfile hashing.** Verify SHA-256 hashes are deterministic for same content, different for different content, absent when no lockfiles exist.

- [x] P6-T4: **Missing runtimes.** Capture snapshot in environment without Go/Rust/Python — no errors thrown, missing runtimes simply omitted.

- [x] P6-T5: **Environment variable redaction.** Verify only names captured (never values), secret-named vars excluded, PATH included.

- [x] P6-T6: **Deterministic serialization.** Same repo produces structurally identical snapshots across calls (excluding timestamp). Valid JSON.

- [x] P6-T7: **Backward compatibility.** Existing traces without snapshot.json continue to work. readSnapshot() returns null. meta.json untouched.

- [x] P6-T8: **Non-git directory.** Capture snapshot outside any git repo — commit=null, branch=null, no errors.

- [x] P6-T9: **Write/read round-trip.** writeSnapshot → readSnapshot produces identical object. Creates directories as needed. Returns null for missing/malformed files.

- [x] P6-T10: **Snapshot size.** Serialized snapshot is under 50KB.

- [x] P6-T11: **Unsafe untracked files excluded.** .env, *.pem, *secret* files not listed in untrackedFiles.

**Phase 6 gate:** all 171 tests pass (132 existing + 39 new), lint clean, build clean.
