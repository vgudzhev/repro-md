# ADR-028: `repro fix` — a bounded fix loop with a pluggable AgentRunner

**Status:** Accepted
**Date:** 2026-08-25

## Context

repro can capture a failure (`record`), replay it deterministically (`run`/`test`), and diagnose it (`inspect`/`diff`/`explain`/`bisect`). It cannot close the loop back to a fix. Doing that by hand today means: read the trace, guess at the fix, edit the repo, re-run `repro test`, repeat — with no isolation from the developer's working tree and no record of what was tried.

`repro fix <id>` automates that loop: verify the reproduction is runnable, confirm it currently fails, hand a structured failure brief to a coding agent working in an isolated worktree, and re-run the reproduction after each attempt. `repro` owns reproduction and verification throughout; the agent only proposes file changes.

## Decision

### Verification is always `repro test`, never the agent's opinion

The single success criterion is the same computation `repro test <id>` performs for one manifest entry: replay the recorded trace in strict mode, evaluate every attached assertion, and require zero divergences and all assertions passing (`checkReproduction` in `src/fix.ts`, deliberately duplicated from `cli.ts`'s `testCommand` rather than shared — the existing precedent in `fork.ts`/`bisect.ts`). No LLM judge, no agent self-report, no partial credit.

### Not every failing assertion is fixable by a code change

Replay serves the exact recorded model responses; the trace events fed to `evaluateAssertions` come from the static `trace.json`, not from anything the live process does. That makes `forbidden_path`, `no_repeat`, and `max_calls` pure functions of the recording — a worktree code change can never flip them, because the "did the agent touch this path" fact was decided at capture time and is replayed byte-for-byte. Only two things are live and therefore fixable:

- `command` assertions, which `execSync` against the worktree's actual filesystem state after replay.
- Divergence itself, since it's driven by tool-execution results that depend on the current worktree.

`runFix` checks this after computing the baseline: if every failing assertion is one of the frozen types and there's no divergence, it aborts immediately with `UnfixableAssertionsError` instead of burning three attempts on a structurally impossible target. This is a deliberate, named limitation — see Consequences.

### The agent cannot reach the assertions that judge it

`checkReproduction` always reads `join(traceDir, "assertions.json")` — the developer's original `.repro/<id>/`, a path never derived from the worktree. Even if an agent edits or deletes its own worktree copy of that file (which may or may not exist there, depending on whether it was committed at the recorded commit), the evaluation is unaffected. This is a structural guarantee, not a policy one.

On top of it, `runFix` runs a git-status guard after every agent invocation: any changed path under `.repro/` inside the worktree aborts the session immediately as `ReproArtifactsModifiedError`, before the reproduction is even re-checked. Belt and suspenders — the guard catches the case (a `.repro/<id>` that *is* tracked at the recorded commit, e.g. fixing a regression against an already-saved reproduction) that the structural guarantee alone wouldn't visibly flag to the developer.

### AgentRunner is an interface, not a call to `claude`

```ts
interface AgentRunner {
  readonly name: string;
  run(brief: FailureBrief, worktreePath: string, env: Record<string, string>): Promise<AgentResult>;
}
```

`ClaudeCodeRunner` is the only implementation shipped — it spawns `claude --print <brief>` in the worktree. `FixSession`/`runFix` know nothing about Claude Code specifically; they only depend on the interface. This is what makes the test suite possible without live LLM calls: tests supply a deterministic fake `AgentRunner` that edits fixture files directly, and `runFix`'s attempt loop, guard, and verification logic run exactly as they would in production.

### The failure brief is compact, not a trace dump

`formatFailureBrief` renders ID, title, each failing assertion's type and one-line message, divergence count if any, the fix requirement, and the constraints — a few hundred bytes, not the full JSON trace. The brief is rebuilt fresh from the *previous* attempt's result on each iteration, so an agent on attempt 2 sees what attempt 1 left failing, not stale information from the baseline.

### FixSession is a first-class, versioned artifact

Stored at `.repro/<id>/fixes/<fix-id>/{session.json,attempts.json}`, `formatVersion`-tagged (`FIX_SESSION_FORMAT_VERSION`). Large fields (`baseline`, `finalResult`, each attempt's `reproductionResult`) go through `writeBlobIfNeeded`/`resolveBlob` from `blob.ts` — the same content-addressed externalization `TraceWriter` uses — rather than a bespoke storage format. `readFixSession` resolves blobs back transparently.

### The worktree is never auto-removed

Every other replay path (`run`, `test`, `bisect`) tears its worktree down when it's done, because those are read-only inspections. `fix` is different: its whole point is to produce a diff a developer might want to `git diff`/`git apply`. Win, lose, or error, `runFix` leaves the worktree in place and reports its path. Nothing is auto-committed to the developer's repo — applying the fix is a manual, reviewed step, same as `git apply` from any other diff.

### Attempt bookkeeping and diff stat

`git status --porcelain` (parsed for the guard and for the changed-files list) and `git diff --numstat` after `git add -A -N` (intent-to-add, so new untracked files show up in the diff instead of being invisible to `git diff`) give attempt-level `changedFiles`/`insertions`/`deletions` without a second isolation mechanism or a diffing library.

The baseline replay itself writes files into the worktree — whatever tool calls the recorded, originally-failing agent made (e.g. it wrote `output.txt`, unrelated to the actual fix). `runFix` snapshots `git status` right after the baseline check and excludes every one of those paths from every subsequent attempt's diff, so `Diff: +N / -M` reports only what the coding agent changed, not the reproduction's own side effects. Tradeoff: if the agent's fix happens to land on a path the replay also writes, that file is excluded from the reported diff even though the agent touched it — acceptable, since the replay overwrites it on every subsequent check anyway, so its final content is never attributable to the agent.

## Rationale

- Reusing `checkReproduction`'s semantics exactly (not "close enough") is what makes "fix verified" mean what the product spec requires: `repro test <id>` passing, full stop.
- Naming the frozen/live assertion split up front, rather than discovering it as a support ticket, keeps the tool honest about what it can and can't do — consistent with D-011's "no false positives, no false promises" posture on assertions.
- The AgentRunner interface is the minimum abstraction that makes `fix` agent-agnostic later without deferring the whole feature — it costs one interface and one implementation now.
- Blob reuse and worktree isolation reuse (D-006, D-009) keep `fix` from introducing a second storage format or a second sandboxing mechanism.

## Consequences

- A reproduction saved with only `forbidden_path`/`no_repeat`/`max_calls` assertions is not fixable by `repro fix` as designed — it will abort with `UnfixableAssertionsError` on the first call. Making a failure fixable requires (or additionally attaching) a `command` assertion that inspects live state.
- `repro fix` requires a live coding agent with real model access (unlike `run`/`test`, which are fully offline) — it is doing new work, not replaying old work.
- Every `fix` attempt leaves a worktree under the OS temp directory if the process crashes mid-loop before writing `session.json`; cleanup in that case is manual (`git worktree prune` from the repo, same as any other interrupted worktree command in this codebase).
- `repro fix` does not commit, open a PR, or otherwise mutate the developer's repository. That's an explicit non-goal, not a missing feature.
