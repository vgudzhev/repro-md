# ADR-023: Session splitting by idle gap

## Status
Accepted

## Context
The daemon cannot know when one Claude Code session ends and another starts — it sees HTTP requests, not process boundaries.

## Decision
Split into a new trace when no request arrives for a configurable idle period. Default: 120 seconds. The developer can adjust this via `idle_split_seconds` in `~/.repro/config.json`.

If a split is wrong, it is cosmetic — two traces instead of one, or one instead of two — never data loss. Every trace produced by the splitter is a complete, valid trace that `repro run` and `repro inspect` accept.

The `SessionSplitter` class owns the idle timer and delegates to `RecordingProxy.resetTrace()` for trace rotation. Because Node's event loop is single-threaded, the timer callback and request handlers cannot run simultaneously, so rotation is atomic with respect to incoming requests.

## Consequences
- Session boundaries are approximate, not exact.
- Developers who run very short sessions back-to-back may see them merged. Developers who pause mid-session may see one session split into two.
- Neither case loses data.
