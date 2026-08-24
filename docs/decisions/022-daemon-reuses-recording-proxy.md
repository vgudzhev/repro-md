# ADR-022: Daemon reuses the recording proxy

## Status
Accepted

## Context
The daemon needs to capture agent sessions the same way `repro record` does — same proxying, same redaction, same trace writing. Building a second proxy path would create drift and double the bug surface.

## Decision
`repro record -- <cmd>` and `repro daemon` use identical code for proxying, recording, redaction, and trace writing. The `RecordingProxy` class gains a `resetTrace()` method that finalizes the current trace writer and creates a new one, and an `onExchangeComplete` callback so external code can track request completion. The difference between the two modes is only lifecycle: `record` wraps one child process and exits when it does; `daemon` listens indefinitely and the `SessionSplitter` calls `resetTrace()` when idle-gap splitting triggers.

## Consequences
- Any fix to recording logic automatically applies to daemon traces.
- `RecordingProxy` gets two new methods/options but no behavioral change for existing callers — `onExchangeComplete` is optional and `resetTrace` is never called by `record`.
