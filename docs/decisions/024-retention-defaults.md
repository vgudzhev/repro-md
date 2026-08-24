# ADR-024: Retention is mandatory from day one

## Status
Accepted

## Context
Always-on recording without retention fills the disk. The daemon must ship with sane defaults.

## Decision
Default retention settings in `~/.repro/config.json`:

```json
{
  "daemon": {
    "idle_split_seconds": 120,
    "retention_days": 7,
    "max_traces": 100,
    "max_disk_mb": 500
  }
}
```

Pruning runs on daemon start and every hour while running. Oldest unsaved traces are deleted first. A trace promoted with `repro save` is moved out of `~/.repro/traces/` into a repo's `.repro/` directory, so it is never subject to daemon pruning.

Three pruning dimensions are checked in order: age (`retention_days`), count (`max_traces`), disk usage (`max_disk_mb`). All three are enforced independently.

## Consequences
- Disk usage is bounded without developer intervention.
- Saved traces are safe from pruning because they live in a different directory.
- The config file is optional — defaults apply if it is absent.
