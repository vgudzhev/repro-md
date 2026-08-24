import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import {
  pruneTraces,
  listDaemonTraces,
  getDaemonDiskUsage,
  loadDaemonConfig,
  DEFAULT_DAEMON_CONFIG,
} from "../src/retention.js";
import type { DaemonConfig, TraceMeta } from "../src/types.js";

const TEST_BASE = join(
  import.meta.dirname,
  "..",
  ".test-retention-" + process.pid,
);

function createTrace(
  tracesDir: string,
  id: string,
  opts: { eventCount?: number; ageMs?: number; sizePadding?: number } = {},
): void {
  const dir = join(tracesDir, id);
  mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const startTime = new Date(now - (opts.ageMs ?? 0)).toISOString();

  const meta: TraceMeta = {
    id,
    command: ["daemon"],
    startTime,
    endTime: startTime,
    eventCount: opts.eventCount ?? 2,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta), "utf-8");

  const traceEvents = [
    { seq: 0, type: "model.request", timestamp: startTime, data: {} },
    { seq: 1, type: "model.response", timestamp: startTime, data: {} },
  ];

  let content = JSON.stringify(traceEvents);
  if (opts.sizePadding) {
    content += " ".repeat(opts.sizePadding);
  }
  writeFileSync(join(dir, "trace.json"), content, "utf-8");

  if (opts.ageMs) {
    const past = new Date(now - opts.ageMs);
    utimesSync(join(dir, "meta.json"), past, past);
  }
}

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_BASE, { recursive: true, force: true });
});

describe("listDaemonTraces", () => {
  it("returns empty array for non-existent directory", () => {
    expect(listDaemonTraces(join(TEST_BASE, "nonexistent"))).toEqual([]);
  });

  it("lists traces sorted by mtime descending", () => {
    const tracesDir = join(TEST_BASE, "traces");
    createTrace(tracesDir, "r-aaa111", { ageMs: 3000 });
    createTrace(tracesDir, "r-bbb222", { ageMs: 1000 });
    createTrace(tracesDir, "r-ccc333", { ageMs: 2000 });

    const traces = listDaemonTraces(tracesDir);
    expect(traces).toHaveLength(3);
    expect(traces[0].id).toBe("r-bbb222");
    expect(traces[1].id).toBe("r-ccc333");
    expect(traces[2].id).toBe("r-aaa111");
  });

  it("skips directories without meta.json", () => {
    const tracesDir = join(TEST_BASE, "traces");
    createTrace(tracesDir, "r-good01");
    mkdirSync(join(tracesDir, "r-bad001"), { recursive: true });

    const traces = listDaemonTraces(tracesDir);
    expect(traces).toHaveLength(1);
    expect(traces[0].id).toBe("r-good01");
  });
});

describe("pruneTraces", () => {
  it("prunes traces older than retention_days", () => {
    const tracesDir = join(TEST_BASE, "traces");
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    const oneDayMs = 1 * 24 * 60 * 60 * 1000;

    createTrace(tracesDir, "r-old001", { ageMs: eightDaysMs });
    createTrace(tracesDir, "r-old002", { ageMs: eightDaysMs + 1000 });
    createTrace(tracesDir, "r-new001", { ageMs: oneDayMs });

    const config: DaemonConfig = {
      ...DEFAULT_DAEMON_CONFIG,
      retention_days: 7,
      max_traces: 100,
    };

    const pruned = pruneTraces(tracesDir, config, new Set());
    expect(pruned).toBe(2);
    expect(existsSync(join(tracesDir, "r-old001"))).toBe(false);
    expect(existsSync(join(tracesDir, "r-old002"))).toBe(false);
    expect(existsSync(join(tracesDir, "r-new001"))).toBe(true);
  });

  it("prunes excess traces when count exceeds max_traces", () => {
    const tracesDir = join(TEST_BASE, "traces");

    createTrace(tracesDir, "r-tr0001", { ageMs: 5000 });
    createTrace(tracesDir, "r-tr0002", { ageMs: 4000 });
    createTrace(tracesDir, "r-tr0003", { ageMs: 3000 });
    createTrace(tracesDir, "r-tr0004", { ageMs: 2000 });
    createTrace(tracesDir, "r-tr0005", { ageMs: 1000 });

    const config: DaemonConfig = {
      ...DEFAULT_DAEMON_CONFIG,
      max_traces: 3,
      retention_days: 365,
    };

    const pruned = pruneTraces(tracesDir, config, new Set());
    expect(pruned).toBe(2);

    const remaining = readdirSync(tracesDir);
    expect(remaining).toHaveLength(3);
    expect(existsSync(join(tracesDir, "r-tr0001"))).toBe(false);
    expect(existsSync(join(tracesDir, "r-tr0002"))).toBe(false);
    expect(existsSync(join(tracesDir, "r-tr0005"))).toBe(true);
  });

  it("prunes by disk usage when exceeding max_disk_mb", () => {
    const tracesDir = join(TEST_BASE, "traces");
    const paddingSize = 600 * 1024;

    createTrace(tracesDir, "r-big001", {
      ageMs: 3000,
      sizePadding: paddingSize,
    });
    createTrace(tracesDir, "r-big002", {
      ageMs: 2000,
      sizePadding: paddingSize,
    });
    createTrace(tracesDir, "r-big003", {
      ageMs: 1000,
      sizePadding: paddingSize,
    });

    const config: DaemonConfig = {
      ...DEFAULT_DAEMON_CONFIG,
      max_disk_mb: 1,
      retention_days: 365,
      max_traces: 100,
    };

    const pruned = pruneTraces(tracesDir, config, new Set());
    expect(pruned).toBeGreaterThanOrEqual(1);
  });

  it("never prunes saved trace IDs", () => {
    const tracesDir = join(TEST_BASE, "traces");
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;

    createTrace(tracesDir, "r-saved1", { ageMs: eightDaysMs });
    createTrace(tracesDir, "r-unsav1", { ageMs: eightDaysMs });

    const config: DaemonConfig = {
      ...DEFAULT_DAEMON_CONFIG,
      retention_days: 7,
    };

    const savedIds = new Set(["r-saved1"]);
    const pruned = pruneTraces(tracesDir, config, savedIds);
    expect(pruned).toBe(1);
    expect(existsSync(join(tracesDir, "r-saved1"))).toBe(true);
    expect(existsSync(join(tracesDir, "r-unsav1"))).toBe(false);
  });

  it("returns 0 for non-existent directory", () => {
    expect(
      pruneTraces(
        join(TEST_BASE, "nonexistent"),
        DEFAULT_DAEMON_CONFIG,
        new Set(),
      ),
    ).toBe(0);
  });
});

describe("getDaemonDiskUsage", () => {
  it("returns zeros for non-existent directory", () => {
    const result = getDaemonDiskUsage(join(TEST_BASE, "nonexistent"));
    expect(result.totalMb).toBe(0);
    expect(result.traceCount).toBe(0);
  });

  it("reports correct trace count", () => {
    const tracesDir = join(TEST_BASE, "traces");
    createTrace(tracesDir, "r-cnt001", { sizePadding: 4096 });
    createTrace(tracesDir, "r-cnt002", { sizePadding: 4096 });
    createTrace(tracesDir, "r-cnt003", { sizePadding: 4096 });

    const result = getDaemonDiskUsage(tracesDir);
    expect(result.traceCount).toBe(3);
    expect(result.totalMb).toBeGreaterThan(0);
  });
});

describe("loadDaemonConfig", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadDaemonConfig();
    expect(config.idle_split_seconds).toBe(120);
    expect(config.retention_days).toBe(7);
    expect(config.max_traces).toBe(100);
    expect(config.max_disk_mb).toBe(500);
    expect(config.port).toBe(7717);
  });
});
