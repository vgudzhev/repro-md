# ADR-027: Fork and bisect for agent debugging

**Status:** Accepted  
**Date:** 2026-08-25

## Context

repro.md can record and replay agent sessions. Replay answers "show me the same failure." Two related workflows are missing:

- **Fork:** "Let me experiment from just before the failure" — replay up to a specific step, then continue with a live agent/model.
- **Bisect:** "Tell me which code change introduced the failure" — binary search over a commit range, replaying the recording at each candidate to classify it as good, bad, or unreproducible.

## Decision

### Fork

`repro fork <id> --at <step>` replays the first N-1 model exchanges from the recording, then switches to live upstream execution from step N onward.

A **ForkProxy** serves positional responses from the recording for the replay portion, then transparently proxies to the real upstream API for live execution. This avoids modifying the existing ReplayProxy or RecordingProxy.

State reconstruction:
- **Conversation:** replayed through recorded model exchanges
- **Filesystem:** reconstructed via git worktree at the recorded commit (ADR-006)
- **External state:** explicitly NOT reconstructed — the fork warns loudly about this

### Bisect

`repro bisect run <id> --good <commit> --bad <commit>` performs a binary search using `git rev-list --ancestry-path` to enumerate candidates, then evaluates each via the existing replay infrastructure.

Each candidate is classified into one of four explicit states:
- **GOOD** — replay matches, assertions pass
- **BAD** — replay matches, assertions fail
- **UNREPRODUCIBLE** — replay diverges (environment mismatch)
- **ERROR** — infrastructure failure (missing binary, worktree error)

An UNREPRODUCIBLE candidate does NOT count as GOOD. Bisect stops when it encounters an unevaluable candidate rather than poisoning the search with false data.

## Rationale

- Fork reuses the existing worktree isolation (ADR-006) and trace format (ADR-008) without modifications.
- Bisect reuses the existing ReplayProxy and assertion engine.
- The four-state verdict model prevents false negatives from environment mismatches being silently classified as "good."
- Binary search uses git's commit graph (ancestry-path) rather than assuming linear history.

## Consequences

- Fork requires a live API key for the post-fork portion (or a custom upstream).
- Bisect latency scales with O(log n) replay evaluations.
- External state (network, databases) cannot be reconstructed by fork — this is stated explicitly rather than silently producing invalid state.
- Each bisect candidate creates and tears down an isolated worktree.
