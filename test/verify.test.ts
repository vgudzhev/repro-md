import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  verify,
  runAllChecks,
  computeVerdict,
  formatVerifyResult,
  formatVerifyJson,
  verifyTraceIntegrity,
  verifyMetaIntegrity,
  verifyRequiredBlobs,
  verifyGitCommit,
  verifyRepositoryState,
  verifyRuntimeVersion,
  verifyAgentBinary,
  verifyModelCompatibility,
  verifyReplayPrerequisites,
  verifyWorktreePrerequisites,
  verifyLockfileHash,
  verifyPlatform,
  verifyArchitecture,
  verifyPackageManager,
  verifyRequiredFiles,
  verifyAgentVersion,
} from "../src/verify.js";
import { TraceReader } from "../src/trace.js";
import type { TraceMeta, TraceEvent } from "../src/types.js";
import type { VerifyOptions, VerifyCheck } from "../src/verify.js";

const TEST_BASE = join(
  import.meta.dirname,
  "..",
  ".test-verify-" + process.pid,
);

function traceDir(id: string): string {
  return join(TEST_BASE, ".repro", id);
}

function initGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', {
    cwd: dir,
    stdio: "pipe",
  });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "test-input.txt"), "hello world", "utf-8");
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
  return execSync("git rev-parse HEAD", {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
}

function writeTrace(dir: string, events: TraceEvent[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "trace.json"),
    JSON.stringify(events, null, 2),
    "utf-8",
  );
}

function writeMeta(dir: string, meta: TraceMeta): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify(meta, null, 2),
    "utf-8",
  );
}

function makeEvents(count: number): TraceEvent[] {
  const events: TraceEvent[] = [];
  events.push({
    seq: 0,
    type: "process.start",
    timestamp: new Date().toISOString(),
    data: { command: ["node", "agent.js"] },
  });
  for (let i = 1; i < count - 1; i += 2) {
    events.push({
      seq: i,
      type: "model.request",
      timestamp: new Date().toISOString(),
      data: { normalizedHash: "abc123", body: {} },
    });
    events.push({
      seq: i + 1,
      type: "model.response",
      timestamp: new Date().toISOString(),
      data: { body: { content: [{ type: "text", text: "hello" }] } },
    });
  }
  events.push({
    seq: count - 1,
    type: "process.exit",
    timestamp: new Date().toISOString(),
    data: { code: 0 },
  });
  return events;
}

function makeOpts(
  id: string,
  meta: Partial<TraceMeta> = {},
): VerifyOptions {
  const dir = traceDir(id);
  const fullMeta: TraceMeta = {
    id,
    command: ["node", "agent.js"],
    startTime: new Date().toISOString(),
    eventCount: 4,
    ...meta,
  };
  writeMeta(dir, fullMeta);

  const events = makeEvents(4);
  writeTrace(dir, events);

  const reader = new TraceReader(dir);
  return {
    repoDir: TEST_BASE,
    traceDir: dir,
    meta: fullMeta,
    reader,
  };
}

let commit: string;

beforeEach(() => {
  commit = initGitRepo(TEST_BASE);
});

afterEach(() => {
  rmSync(TEST_BASE, { recursive: true, force: true });
});

describe("verify — perfect match", () => {
  it("reports REPLAYABLE when everything matches", () => {
    const id = "r-perfect";
    const opts = makeOpts(id, {
      commit,
      command: ["node", "agent.js"],
    });

    const checks = runAllChecks(opts);
    const verdict = computeVerdict(checks);

    expect(verdict).toBe("REPLAYABLE");
    expect(checks.every(c => c.status === "PASS" || c.status === "UNKNOWN")).toBe(true);
    const fails = checks.filter(c => c.status === "FAIL");
    expect(fails).toHaveLength(0);
  });

  it("verify() returns full result structure", () => {
    const id = "r-full";
    const dir = traceDir(id);
    writeTrace(dir, makeEvents(4));
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 4,
      commit,
    });

    const result = verify(id, dir, TEST_BASE);

    expect(result.id).toBe(id);
    expect(result.canReplay).toBe(true);
    expect(result.verdict).toBe("REPLAYABLE");
    expect(result.checks.length).toBeGreaterThan(0);
  });
});

describe("verify — trace integrity", () => {
  it("fails when trace.json is missing", () => {
    const id = "r-notrace";
    const dir = traceDir(id);
    mkdirSync(dir, { recursive: true });
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 0,
    });

    const reader = new TraceReader(dir);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const result = verifyTraceIntegrity({
      repoDir: TEST_BASE,
      traceDir: dir,
      meta,
      reader,
    });

    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("not found");
  });

  it("fails when trace.json is corrupt", () => {
    const id = "r-corrupt";
    const dir = traceDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "trace.json"), "{not valid json[", "utf-8");
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 0,
    });

    const reader = new TraceReader(dir);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const result = verifyTraceIntegrity({
      repoDir: TEST_BASE,
      traceDir: dir,
      meta,
      reader,
    });

    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("corrupt");
  });

  it("fails when trace events have missing fields", () => {
    const id = "r-badevt";
    const dir = traceDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "trace.json"),
      JSON.stringify([{ wrongField: true }]),
      "utf-8",
    );
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 1,
    });

    const reader = new TraceReader(dir);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const result = verifyTraceIntegrity({
      repoDir: TEST_BASE,
      traceDir: dir,
      meta,
      reader,
    });

    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("malformed");
  });

  it("warns on empty trace", () => {
    const id = "r-empty";
    const dir = traceDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "trace.json"), "[]", "utf-8");
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 0,
    });

    const reader = new TraceReader(dir);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const result = verifyTraceIntegrity({
      repoDir: TEST_BASE,
      traceDir: dir,
      meta,
      reader,
    });

    expect(result.status).toBe("WARN");
  });
});

describe("verify — required blobs", () => {
  it("passes when no blobs exist", () => {
    const opts = makeOpts("r-noblob", { commit });
    const result = verifyRequiredBlobs(opts);
    expect(result.status).toBe("PASS");
  });

  it("fails when referenced blob is missing", () => {
    const id = "r-missblob";
    const dir = traceDir(id);
    mkdirSync(join(dir, "blobs"), { recursive: true });

    const events: TraceEvent[] = [
      {
        seq: 0,
        type: "model.request",
        timestamp: new Date().toISOString(),
        data: { body: "blob:sha256-deadbeef1234567890abcdef" },
      },
    ];
    writeTrace(dir, events);
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 1,
    });

    const reader = new TraceReader(dir);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const result = verifyRequiredBlobs({
      repoDir: TEST_BASE,
      traceDir: dir,
      meta,
      reader,
    });

    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("missing");
  });

  it("passes when all blobs exist", () => {
    const id = "r-allblob";
    const dir = traceDir(id);
    const blobDir = join(dir, "blobs");
    mkdirSync(blobDir, { recursive: true });

    const hash = "aabbccdd11223344";
    writeFileSync(join(blobDir, hash), "blob content", "utf-8");

    const events: TraceEvent[] = [
      {
        seq: 0,
        type: "model.request",
        timestamp: new Date().toISOString(),
        data: { body: `blob:sha256-${hash}` },
      },
    ];
    writeTrace(dir, events);
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 1,
    });

    const reader = new TraceReader(dir);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const result = verifyRequiredBlobs({
      repoDir: TEST_BASE,
      traceDir: dir,
      meta,
      reader,
    });

    expect(result.status).toBe("PASS");
  });
});

describe("verify — git commit", () => {
  it("passes when commit exists in repo", () => {
    const opts = makeOpts("r-commit", { commit });
    const result = verifyGitCommit(opts);
    expect(result.status).toBe("PASS");
  });

  it("fails when commit is not found", () => {
    const opts = makeOpts("r-nocommit", {
      commit: "0000000000000000000000000000000000000000",
    });
    const result = verifyGitCommit(opts);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("not found");
  });

  it("reports UNKNOWN when no commit recorded", () => {
    const opts = makeOpts("r-unkncommit");
    const result = verifyGitCommit(opts);
    expect(result.status).toBe("UNKNOWN");
  });
});

describe("verify — runtime version", () => {
  it("passes when major version matches", () => {
    const currentMajor = process.version.replace(/^v/, "").split(".")[0];
    const opts = makeOpts("r-rtmatch", {
      commit,
      env: { REPRO_NODE_VERSION: `${currentMajor}.0.0` },
    });
    const result = verifyRuntimeVersion(opts);
    expect(result.status === "PASS" || result.status === "WARN").toBe(true);
  });

  it("fails when major version mismatches", () => {
    const opts = makeOpts("r-rtfail", {
      commit,
      env: { REPRO_NODE_VERSION: "14.0.0" },
    });
    const result = verifyRuntimeVersion(opts);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("required");
    expect(result.message).toContain("detected");
  });

  it("reports UNKNOWN when no version recorded", () => {
    const opts = makeOpts("r-rtunk");
    const result = verifyRuntimeVersion(opts);
    expect(result.status).toBe("UNKNOWN");
  });
});

describe("verify — missing binary", () => {
  it("fails when agent binary does not exist", () => {
    const opts = makeOpts("r-nobin", {
      commit,
      command: ["repro-nonexistent-binary-xyz", "--help"],
    });
    const result = verifyAgentBinary(opts);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("not found");
  });

  it("passes for node", () => {
    const opts = makeOpts("r-nodebin", {
      commit,
      command: ["node", "agent.js"],
    });
    const result = verifyAgentBinary(opts);
    expect(result.status).toBe("PASS");
  });
});

describe("verify — changed lockfile", () => {
  it("warns when lockfile hash differs", () => {
    writeFileSync(
      join(TEST_BASE, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3 }),
      "utf-8",
    );

    const opts = makeOpts("r-lockdiff", {
      commit,
      env: { REPRO_LOCKFILE_HASH: "0000000000000000000000000000000000000000000000000000000000000000" },
    });

    const result = verifyLockfileHash(opts);
    expect(result.status).toBe("WARN");
    expect(result.message).toContain("differs");
  });

  it("reports UNKNOWN when no lockfile hash recorded", () => {
    const opts = makeOpts("r-nolockhash");
    const result = verifyLockfileHash(opts);
    expect(result.status).toBe("UNKNOWN");
  });
});

describe("verify — dirty working tree", () => {
  it("warns on uncommitted changes", () => {
    const opts = makeOpts("r-dirty", { commit });
    writeFileSync(join(TEST_BASE, "untracked.txt"), "dirty", "utf-8");

    const result = verifyRepositoryState(opts);
    expect(result.status).toBe("WARN");
    expect(result.message).toContain("uncommitted");
  });

  it("passes on clean tree", () => {
    const opts = makeOpts("r-clean", { commit });
    const result = verifyRepositoryState(opts);
    expect(result.status).toBe("PASS");
  });
});

describe("verify — model mismatch", () => {
  it("passes when model responses are present", () => {
    const opts = makeOpts("r-model", { commit, model: "claude-sonnet-4" });
    const result = verifyModelCompatibility(opts);
    expect(result.status).toBe("PASS");
    expect(result.message).toContain("response(s)");
  });

  it("warns when no model responses in trace", () => {
    const id = "r-nomodel";
    const dir = traceDir(id);
    const events: TraceEvent[] = [
      {
        seq: 0,
        type: "process.start",
        timestamp: new Date().toISOString(),
        data: { command: ["node", "agent.js"] },
      },
      {
        seq: 1,
        type: "process.exit",
        timestamp: new Date().toISOString(),
        data: { code: 0 },
      },
    ];
    writeTrace(dir, events);
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 2,
    });

    const reader = new TraceReader(dir);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const result = verifyModelCompatibility({
      repoDir: TEST_BASE,
      traceDir: dir,
      meta,
      reader,
    });

    expect(result.status).toBe("WARN");
  });
});

describe("verify — unknown environment fields", () => {
  it("reports UNKNOWN for platform when not recorded", () => {
    const opts = makeOpts("r-noplatform", { commit });
    const result = verifyPlatform(opts);
    expect(result.status).toBe("UNKNOWN");
  });

  it("reports UNKNOWN for architecture when not recorded", () => {
    const opts = makeOpts("r-noarch", { commit });
    const result = verifyArchitecture(opts);
    expect(result.status).toBe("UNKNOWN");
  });

  it("reports UNKNOWN for package manager when not recorded", () => {
    const opts = makeOpts("r-nopm", { commit });
    const result = verifyPackageManager(opts);
    expect(result.status).toBe("UNKNOWN");
  });

  it("reports UNKNOWN for agent version when not recorded", () => {
    const opts = makeOpts("r-noagentv", { commit });
    const result = verifyAgentVersion(opts);
    expect(result.status).toBe("UNKNOWN");
  });

  it("reports UNKNOWN for required files when not recorded", () => {
    const opts = makeOpts("r-noreqfiles", { commit });
    const result = verifyRequiredFiles(opts);
    expect(result.status).toBe("UNKNOWN");
  });
});

describe("verify — old trace versions / corrupted snapshot", () => {
  it("handles trace with non-array JSON", () => {
    const id = "r-notarray";
    const dir = traceDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "trace.json"), '{"not": "array"}', "utf-8");
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 0,
    });

    const reader = new TraceReader(dir);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const result = verifyTraceIntegrity({
      repoDir: TEST_BASE,
      traceDir: dir,
      meta,
      reader,
    });

    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("not an array");
  });

  it("handles meta with missing required fields", () => {
    const id = "r-badmeta";
    const dir = traceDir(id);
    mkdirSync(dir, { recursive: true });
    writeTrace(dir, []);
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ incomplete: true }),
      "utf-8",
    );

    const reader = new TraceReader(dir);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const result = verifyMetaIntegrity({
      repoDir: TEST_BASE,
      traceDir: dir,
      meta,
      reader,
    });

    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("missing required");
  });
});

describe("verify — replay prerequisites", () => {
  it("passes with balanced request/response pairs", () => {
    const opts = makeOpts("r-balanced", { commit });
    const result = verifyReplayPrerequisites(opts);
    expect(result.status).toBe("PASS");
    expect(result.message).toContain("complete exchange");
  });

  it("warns when requests and responses are unbalanced", () => {
    const id = "r-unbalanced";
    const dir = traceDir(id);
    const events: TraceEvent[] = [
      {
        seq: 0,
        type: "model.request",
        timestamp: new Date().toISOString(),
        data: { body: {} },
      },
      {
        seq: 1,
        type: "model.request",
        timestamp: new Date().toISOString(),
        data: { body: {} },
      },
      {
        seq: 2,
        type: "model.response",
        timestamp: new Date().toISOString(),
        data: { body: {} },
      },
    ];
    writeTrace(dir, events);
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 3,
    });

    const reader = new TraceReader(dir);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const result = verifyReplayPrerequisites({
      repoDir: TEST_BASE,
      traceDir: dir,
      meta,
      reader,
    });

    expect(result.status).toBe("WARN");
    expect(result.message).toContain("incomplete");
  });

  it("warns when no API exchanges are recorded", () => {
    const id = "r-noexch";
    const dir = traceDir(id);
    const events: TraceEvent[] = [
      {
        seq: 0,
        type: "process.start",
        timestamp: new Date().toISOString(),
        data: {},
      },
      {
        seq: 1,
        type: "process.exit",
        timestamp: new Date().toISOString(),
        data: { code: 0 },
      },
    ];
    writeTrace(dir, events);
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 2,
    });

    const reader = new TraceReader(dir);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const result = verifyReplayPrerequisites({
      repoDir: TEST_BASE,
      traceDir: dir,
      meta,
      reader,
    });

    expect(result.status).toBe("WARN");
    expect(result.message).toContain("no-op");
  });
});

describe("verify — worktree prerequisites", () => {
  it("passes when commit is available in git repo", () => {
    const opts = makeOpts("r-wt", { commit });
    const result = verifyWorktreePrerequisites(opts);
    expect(result.status).toBe("PASS");
  });

  it("warns when no commit recorded", () => {
    const opts = makeOpts("r-wt-nocommit");
    const result = verifyWorktreePrerequisites(opts);
    expect(result.status).toBe("WARN");
    expect(result.message).toContain("HEAD");
  });

  it("fails when commit not found", () => {
    const opts = makeOpts("r-wt-badcommit", {
      commit: "0000000000000000000000000000000000000000",
    });
    const result = verifyWorktreePrerequisites(opts);
    expect(result.status).toBe("FAIL");
  });
});

describe("verify — JSON output", () => {
  it("produces valid JSON", () => {
    const id = "r-json";
    const dir = traceDir(id);
    writeTrace(dir, makeEvents(4));
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 4,
      commit,
    });

    const result = verify(id, dir, TEST_BASE);
    const json = formatVerifyJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.id).toBe(id);
    expect(parsed.verdict).toBeDefined();
    expect(parsed.canReplay).toBeDefined();
    expect(parsed.environmentIdentical).toBeDefined();
    expect(parsed.trustworthy).toBeDefined();
    expect(Array.isArray(parsed.checks)).toBe(true);

    for (const check of parsed.checks) {
      expect(check.name).toBeDefined();
      expect(check.status).toBeDefined();
      expect(check.message).toBeDefined();
      expect(check.category).toBeDefined();
      expect(["PASS", "WARN", "FAIL", "UNKNOWN"]).toContain(check.status);
      expect(["trace", "environment", "runtime", "replay"]).toContain(
        check.category,
      );
    }
  });

  it("JSON verdict matches human-readable output", () => {
    const id = "r-json2";
    const dir = traceDir(id);
    writeTrace(dir, makeEvents(4));
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 4,
      commit,
    });

    const result = verify(id, dir, TEST_BASE);
    const text = formatVerifyResult(result);
    const json = JSON.parse(formatVerifyJson(result));

    expect(text).toContain(json.verdict.replace(/_/g, " "));
  });
});

describe("verify — human-readable output", () => {
  it("formats with correct icons", () => {
    const id = "r-format";
    const dir = traceDir(id);
    writeTrace(dir, makeEvents(4));
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 4,
      commit,
    });

    const result = verify(id, dir, TEST_BASE);
    const text = formatVerifyResult(result);

    expect(text).toContain(`Reproduction: ${id}`);
    expect(text).toContain("Result:");
    expect(text).toContain("✓");
  });

  it("shows warning icon for WARN checks", () => {
    const id = "r-fmtwarn";
    const dir = traceDir(id);
    writeTrace(dir, makeEvents(4));
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 4,
      commit,
      env: { REPRO_NODE_VERSION: "14.0.0" },
    });

    const result = verify(id, dir, TEST_BASE);
    const text = formatVerifyResult(result);
    expect(text).toContain("✗");
  });
});

describe("verify — computeVerdict", () => {
  it("returns REPLAYABLE when all pass", () => {
    const checks: VerifyCheck[] = [
      { name: "a", status: "PASS", message: "ok", category: "trace" },
      { name: "b", status: "PASS", message: "ok", category: "environment" },
    ];
    expect(computeVerdict(checks)).toBe("REPLAYABLE");
  });

  it("returns REPLAYABLE with only UNKNOWN", () => {
    const checks: VerifyCheck[] = [
      { name: "a", status: "PASS", message: "ok", category: "trace" },
      { name: "b", status: "UNKNOWN", message: "no data", category: "environment" },
    ];
    expect(computeVerdict(checks)).toBe("REPLAYABLE");
  });

  it("returns REPLAYABLE_WITH_WARNINGS on WARN", () => {
    const checks: VerifyCheck[] = [
      { name: "a", status: "PASS", message: "ok", category: "trace" },
      { name: "b", status: "WARN", message: "differs", category: "environment" },
    ];
    expect(computeVerdict(checks)).toBe("REPLAYABLE_WITH_WARNINGS");
  });

  it("returns NOT_REPLAYABLE on FAIL", () => {
    const checks: VerifyCheck[] = [
      { name: "a", status: "PASS", message: "ok", category: "trace" },
      { name: "b", status: "FAIL", message: "missing", category: "trace" },
    ];
    expect(computeVerdict(checks)).toBe("NOT_REPLAYABLE");
  });

  it("FAIL takes precedence over WARN", () => {
    const checks: VerifyCheck[] = [
      { name: "a", status: "WARN", message: "meh", category: "trace" },
      { name: "b", status: "FAIL", message: "bad", category: "trace" },
    ];
    expect(computeVerdict(checks)).toBe("NOT_REPLAYABLE");
  });
});

describe("verify — result dimensions", () => {
  it("canReplay is true even with warnings", () => {
    const id = "r-canwarn";
    const dir = traceDir(id);
    writeTrace(dir, makeEvents(4));
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 4,
      commit,
      env: { REPRO_PLATFORM: "win32" },
    });

    const result = verify(id, dir, TEST_BASE);
    expect(result.canReplay).toBe(true);
    expect(result.environmentIdentical).toBe(false);
  });

  it("distinguishes environment identity from replayability", () => {
    const id = "r-envdiff";
    const dir = traceDir(id);
    writeTrace(dir, makeEvents(4));
    writeMeta(dir, {
      id,
      command: ["node", "agent.js"],
      startTime: new Date().toISOString(),
      eventCount: 4,
      commit,
    });

    const result = verify(id, dir, TEST_BASE);
    expect(result.canReplay).toBe(true);
    expect(typeof result.environmentIdentical).toBe("boolean");
    expect(typeof result.trustworthy).toBe("boolean");
  });
});

describe("verify — platform checks", () => {
  it("passes when platform matches", () => {
    const opts = makeOpts("r-platmatch", {
      commit,
      env: { REPRO_PLATFORM: process.platform },
    });
    const result = verifyPlatform(opts);
    expect(result.status).toBe("PASS");
  });

  it("warns when platform differs", () => {
    const otherPlatform = process.platform === "linux" ? "darwin" : "linux";
    const opts = makeOpts("r-platdiff", {
      commit,
      env: { REPRO_PLATFORM: otherPlatform },
    });
    const result = verifyPlatform(opts);
    expect(result.status).toBe("WARN");
  });
});

describe("verify — architecture checks", () => {
  it("passes when architecture matches", () => {
    const opts = makeOpts("r-archmatch", {
      commit,
      env: { REPRO_ARCH: process.arch },
    });
    const result = verifyArchitecture(opts);
    expect(result.status).toBe("PASS");
  });

  it("warns when architecture differs", () => {
    const otherArch = process.arch === "x64" ? "arm64" : "x64";
    const opts = makeOpts("r-archdiff", {
      commit,
      env: { REPRO_ARCH: otherArch },
    });
    const result = verifyArchitecture(opts);
    expect(result.status).toBe("WARN");
  });
});

describe("verify — required files", () => {
  it("passes when all required files exist", () => {
    const opts = makeOpts("r-reqfiles", {
      commit,
      env: { REPRO_REQUIRED_FILES: "test-input.txt" },
    });
    const result = verifyRequiredFiles(opts);
    expect(result.status).toBe("PASS");
  });

  it("fails when a required file is missing", () => {
    const opts = makeOpts("r-missingfile", {
      commit,
      env: { REPRO_REQUIRED_FILES: "nonexistent.txt,also-missing.txt" },
    });
    const result = verifyRequiredFiles(opts);
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("missing");
  });
});

describe("verify — extensibility", () => {
  it("runAllChecks returns checks with categories", () => {
    const opts = makeOpts("r-ext", { commit });
    const checks = runAllChecks(opts);

    const categories = new Set(checks.map(c => c.category));
    expect(categories.has("trace")).toBe(true);
    expect(categories.has("environment")).toBe(true);
    expect(categories.has("replay")).toBe(true);

    for (const c of checks) {
      expect(c.name).toBeTruthy();
      expect(c.message).toBeTruthy();
      expect(["PASS", "WARN", "FAIL", "UNKNOWN"]).toContain(c.status);
    }
  });
});
