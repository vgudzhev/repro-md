import {
  readdirSync,
  statSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import type { DaemonConfig, TraceMeta } from "./types.js";

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  idle_split_seconds: 120,
  retention_days: 7,
  max_traces: 100,
  max_disk_mb: 500,
  port: 7717,
};

export function loadDaemonConfig(): DaemonConfig {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const configPath = join(homeDir, ".repro", "config.json");

  if (!existsSync(configPath)) {
    return { ...DEFAULT_DAEMON_CONFIG };
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const daemon = raw.daemon ?? {};
    return {
      idle_split_seconds:
        daemon.idle_split_seconds ?? DEFAULT_DAEMON_CONFIG.idle_split_seconds,
      retention_days:
        daemon.retention_days ?? DEFAULT_DAEMON_CONFIG.retention_days,
      max_traces: daemon.max_traces ?? DEFAULT_DAEMON_CONFIG.max_traces,
      max_disk_mb: daemon.max_disk_mb ?? DEFAULT_DAEMON_CONFIG.max_disk_mb,
      port: daemon.port ?? DEFAULT_DAEMON_CONFIG.port,
    };
  } catch {
    return { ...DEFAULT_DAEMON_CONFIG };
  }
}

function getDirectorySize(dirPath: string): number {
  let totalSize = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += getDirectorySize(fullPath);
      } else {
        try {
          totalSize += statSync(fullPath).size;
        } catch {
          // file may have been deleted concurrently
        }
      }
    }
  } catch {
    // directory may not exist
  }
  return totalSize;
}

export interface TraceInfo {
  id: string;
  dir: string;
  meta: TraceMeta;
  size: number;
  mtime: Date;
}

export function listDaemonTraces(tracesDir: string): TraceInfo[] {
  if (!existsSync(tracesDir)) return [];

  return readdirSync(tracesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("r-"))
    .map((d) => {
      const dir = join(tracesDir, d.name);
      const metaPath = join(dir, "meta.json");
      if (!existsSync(metaPath)) return null;

      try {
        const meta: TraceMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
        const size = getDirectorySize(dir);
        const mtime = statSync(metaPath).mtime;
        return { id: d.name, dir, meta, size, mtime };
      } catch {
        return null;
      }
    })
    .filter((t): t is TraceInfo => t !== null)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export function pruneTraces(
  tracesDir: string,
  config: DaemonConfig,
  savedIds: Set<string>,
): number {
  if (!existsSync(tracesDir)) return 0;

  const traces = listDaemonTraces(tracesDir);
  const toPrune = new Set<string>();
  const now = Date.now();

  const prunableTraces = traces.filter((t) => !savedIds.has(t.id));
  prunableTraces.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

  for (const trace of prunableTraces) {
    const ageDays = (now - trace.mtime.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > config.retention_days) {
      toPrune.add(trace.id);
    }
  }

  const remainingAfterAge = traces.filter((t) => !toPrune.has(t.id));
  if (remainingAfterAge.length > config.max_traces) {
    const excess = remainingAfterAge.length - config.max_traces;
    const prunableRemaining = remainingAfterAge
      .filter((t) => !savedIds.has(t.id))
      .sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

    for (let i = 0; i < Math.min(excess, prunableRemaining.length); i++) {
      toPrune.add(prunableRemaining[i].id);
    }
  }

  let totalSizeMb =
    traces
      .filter((t) => !toPrune.has(t.id))
      .reduce((sum, t) => sum + t.size, 0) /
    (1024 * 1024);

  if (totalSizeMb > config.max_disk_mb) {
    const prunableBySize = traces
      .filter((t) => !toPrune.has(t.id) && !savedIds.has(t.id))
      .sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

    for (const trace of prunableBySize) {
      if (totalSizeMb <= config.max_disk_mb) break;
      toPrune.add(trace.id);
      totalSizeMb -= trace.size / (1024 * 1024);
    }
  }

  let pruned = 0;
  for (const id of toPrune) {
    const trace = traces.find((t) => t.id === id);
    if (trace) {
      try {
        rmSync(trace.dir, { recursive: true, force: true });
        pruned++;
      } catch {
        // ignore delete failures
      }
    }
  }

  return pruned;
}

export function getDaemonDiskUsage(tracesDir: string): {
  totalMb: number;
  traceCount: number;
} {
  if (!existsSync(tracesDir)) return { totalMb: 0, traceCount: 0 };

  const traces = listDaemonTraces(tracesDir);
  const totalBytes = traces.reduce((sum, t) => sum + t.size, 0);

  return {
    totalMb: Math.round((totalBytes / (1024 * 1024)) * 100) / 100,
    traceCount: traces.length,
  };
}
