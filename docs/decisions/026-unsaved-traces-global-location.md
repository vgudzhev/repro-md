# ADR-026: Unsaved daemon traces stored globally

## Status
Accepted

## Context
The daemon does not know which repo a request belongs to. It cannot write traces into a repo's `.repro/` directory because it does not know which repo to target.

## Decision
Unsaved daemon traces are stored in `~/.repro/traces/<id>/`. When the developer runs `repro save <id>` from inside a repo, the trace is moved from `~/.repro/traces/<id>/` into that repo's `.repro/<id>/` directory and added to `REPRO.md`.

`repro list` shows both: repo traces (from `.repro/`) and unsaved daemon traces (from `~/.repro/traces/`), labelled by source.

After `repro save`, the trace is no longer in `~/.repro/traces/` — it belongs to the repo now and follows repo-level retention (git-tracked, never auto-pruned).

## Consequences
- The daemon can write traces without knowing the repo context.
- `repro list` must read from two locations.
- `repro save` on a daemon trace is a move operation, not a copy.
- `repro inspect` and other trace-reading commands check both locations.
