# ADR-025: Daemon is a detached process, not a system service

## Status
Accepted

## Context
The daemon needs to run in the background but should not require systemd, launchd, pm2, or any process manager.

## Decision
`repro daemon start` spawns a detached child process using Node's `child_process.spawn` with `detached: true` and `child.unref()`. The child writes a JSON status file to `~/.repro/daemon.json` containing `pid`, `port`, and `startTime`. `repro daemon stop` reads the PID and sends SIGTERM.

The daemon.json file lives at `~/.repro/daemon.json` (not per-repo) because the daemon is a global process that serves all repos.

On startup, the daemon checks for a stale daemon.json. If the PID is dead, it cleans up the file and starts. If alive, it refuses to start and reports the existing PID.

Child process stdout and stderr are redirected to `~/.repro/daemon.log` for diagnostics.

Graceful shutdown on SIGTERM: stop accepting new requests, finalize any active trace, wait up to 5 seconds for in-flight request/response pairs to complete, then exit.

## Consequences
- No external process manager dependency.
- The developer manages the daemon lifecycle with `repro daemon start/stop/status`.
- The daemon does not survive reboots — the developer must restart it manually or add it to their shell profile.
