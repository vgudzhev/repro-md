import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  captureSnapshot,
  formatSnapshot,
  writeSnapshot,
  readSnapshot,
  SNAPSHOT_FORMAT_VERSION,
} from "../src/snapshot.js";
import type { EnvironmentSnapshot } from "../src/snapshot.js";

const TEST_BASE = join(
  import.meta.dirname,
  "..",
  ".test-snapshot-" + process.pid,
);

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf-8");
  execSync("git add -A && git commit -m 'init'", { cwd: dir, stdio: "pipe" });
}

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_BASE, { recursive: true, force: true });
});

describe("captureSnapshot", () => {
  it("captures snapshot from a clean git repository", () => {
    const repoDir = join(TEST_BASE, "clean-repo");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.formatVersion).toBe(SNAPSHOT_FORMAT_VERSION);
    expect(snapshot.timestamp).toBeDefined();
    expect(new Date(snapshot.timestamp).getTime()).not.toBeNaN();

    expect(snapshot.repository.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.repository.dirty).toBe(false);
    expect(snapshot.repository.dirtyFileCount).toBe(0);
    expect(snapshot.repository.dirtyDiff).toBeNull();
    expect(snapshot.repository.root).toBe(repoDir);
  });

  it("captures snapshot from a dirty git repository", () => {
    const repoDir = join(TEST_BASE, "dirty-repo");
    initGitRepo(repoDir);

    writeFileSync(join(repoDir, "dirty.txt"), "uncommitted change\n", "utf-8");

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.repository.dirty).toBe(true);
    expect(snapshot.repository.dirtyFileCount).toBeGreaterThan(0);
  });

  it("includes dirty diff when worktree has modifications", () => {
    const repoDir = join(TEST_BASE, "diff-repo");
    initGitRepo(repoDir);

    writeFileSync(join(repoDir, "README.md"), "# modified\nextra line\n", "utf-8");
    execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.repository.dirty).toBe(true);
    expect(snapshot.repository.dirtyDiff).toBeDefined();
    expect(snapshot.repository.dirtyDiff).toContain("README.md");
  });

  it("lists safe untracked files", () => {
    const repoDir = join(TEST_BASE, "untracked-repo");
    initGitRepo(repoDir);

    writeFileSync(join(repoDir, "new-file.ts"), "export const x = 1;\n", "utf-8");
    writeFileSync(join(repoDir, "data.json"), "{}\n", "utf-8");

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.repository.untrackedFiles).toContain("new-file.ts");
    expect(snapshot.repository.untrackedFiles).toContain("data.json");
  });

  it("excludes unsafe untracked files", () => {
    const repoDir = join(TEST_BASE, "unsafe-untracked");
    initGitRepo(repoDir);

    writeFileSync(join(repoDir, ".env"), "SECRET=bad\n", "utf-8");
    writeFileSync(join(repoDir, "creds.pem"), "cert\n", "utf-8");
    writeFileSync(join(repoDir, "my-secret-config"), "x\n", "utf-8");
    writeFileSync(join(repoDir, "safe.ts"), "ok\n", "utf-8");

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.repository.untrackedFiles).not.toContain(".env");
    expect(snapshot.repository.untrackedFiles).not.toContain("creds.pem");
    expect(snapshot.repository.untrackedFiles).not.toContain("my-secret-config");
    expect(snapshot.repository.untrackedFiles).toContain("safe.ts");
  });

  it("captures platform information", () => {
    const repoDir = join(TEST_BASE, "platform-repo");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.platform.os).toBeDefined();
    expect(snapshot.platform.arch).toBeDefined();
    expect(snapshot.platform.release).toBeDefined();
    expect(typeof snapshot.platform.os).toBe("string");
    expect(typeof snapshot.platform.arch).toBe("string");
  });

  it("detects node runtime", () => {
    const repoDir = join(TEST_BASE, "runtime-repo");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.runtimes.node).toBeDefined();
    expect(snapshot.runtimes.node).toMatch(/^\d+\.\d+/);
  });

  it("detects npm as package manager when package-lock.json exists", () => {
    const repoDir = join(TEST_BASE, "npm-repo");
    initGitRepo(repoDir);
    writeFileSync(join(repoDir, "package-lock.json"), "{}\n", "utf-8");

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.packageManager.name).toBe("npm");
  });

  it("returns null package manager when no lockfile exists", () => {
    const repoDir = join(TEST_BASE, "no-pm-repo");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.packageManager.name).toBeNull();
  });

  it("handles missing runtimes gracefully", () => {
    const repoDir = join(TEST_BASE, "missing-runtimes");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.runtimes).toBeDefined();
    expect(typeof snapshot.runtimes).toBe("object");
    // Go/Rust/Python may or may not be present - should not throw
  });

  it("handles directory outside a git repository", () => {
    // Use /tmp to avoid inheriting the parent repo's git context
    const nonGitDir = join("/tmp", "repro-snapshot-no-git-" + process.pid);
    mkdirSync(nonGitDir, { recursive: true });

    try {
      const snapshot = captureSnapshot({ cwd: nonGitDir });

      expect(snapshot.repository.commit).toBeNull();
      expect(snapshot.repository.branch).toBeNull();
      expect(snapshot.repository.dirty).toBe(false);
      expect(snapshot.repository.untrackedFiles).toEqual([]);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("captures agent info from options", () => {
    const repoDir = join(TEST_BASE, "agent-repo");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({
      cwd: repoDir,
      agentName: "claude-code",
      agentVersion: "2.4.1",
      model: "claude-sonnet-4-20250514",
    });

    expect(snapshot.agent.name).toBe("claude-code");
    expect(snapshot.agent.version).toBe("2.4.1");
    expect(snapshot.agent.model).toBe("claude-sonnet-4-20250514");
  });

  it("captures relative workdir path", () => {
    const repoDir = join(TEST_BASE, "workdir-repo");
    initGitRepo(repoDir);
    const subDir = join(repoDir, "packages", "core");
    mkdirSync(subDir, { recursive: true });

    const snapshot = captureSnapshot({ cwd: subDir });

    expect(snapshot.workdir.relativeToRepo).toBe("packages/core");
    expect(snapshot.workdir.absolute).toBe(subDir);
  });

  it("captures workdir as '.' when at repo root", () => {
    const repoDir = join(TEST_BASE, "root-workdir");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.workdir.relativeToRepo).toBe(".");
  });

  it("captures branch name", () => {
    const repoDir = join(TEST_BASE, "branch-repo");
    initGitRepo(repoDir);
    execSync("git checkout -b feature/test-branch", { cwd: repoDir, stdio: "pipe" });

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.repository.branch).toBe("feature/test-branch");
  });
});

describe("lockfile hashing", () => {
  it("hashes package-lock.json when present", () => {
    const repoDir = join(TEST_BASE, "lockfile-repo");
    initGitRepo(repoDir);
    writeFileSync(join(repoDir, "package-lock.json"), '{"lockfileVersion":3}\n', "utf-8");

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.lockfileHashes["package-lock.json"]).toBeDefined();
    expect(snapshot.lockfileHashes["package-lock.json"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("produces deterministic hashes for same content", () => {
    const repoDir = join(TEST_BASE, "deterministic-lock");
    initGitRepo(repoDir);
    const content = '{"lockfileVersion":3,"packages":{}}\n';
    writeFileSync(join(repoDir, "package-lock.json"), content, "utf-8");

    const snap1 = captureSnapshot({ cwd: repoDir });
    const snap2 = captureSnapshot({ cwd: repoDir });

    expect(snap1.lockfileHashes["package-lock.json"]).toBe(
      snap2.lockfileHashes["package-lock.json"],
    );
  });

  it("returns different hashes for different content", () => {
    const repoDir = join(TEST_BASE, "diff-lock");
    initGitRepo(repoDir);

    writeFileSync(join(repoDir, "package-lock.json"), '{"v":1}\n', "utf-8");
    const snap1 = captureSnapshot({ cwd: repoDir });

    writeFileSync(join(repoDir, "package-lock.json"), '{"v":2}\n', "utf-8");
    const snap2 = captureSnapshot({ cwd: repoDir });

    expect(snap1.lockfileHashes["package-lock.json"]).not.toBe(
      snap2.lockfileHashes["package-lock.json"],
    );
  });

  it("returns empty when no lockfiles exist", () => {
    const repoDir = join(TEST_BASE, "no-lockfile");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(Object.keys(snapshot.lockfileHashes)).toHaveLength(0);
  });

  it("hashes multiple lockfiles when present", () => {
    const repoDir = join(TEST_BASE, "multi-lockfile");
    initGitRepo(repoDir);
    writeFileSync(join(repoDir, "package-lock.json"), "{}\n", "utf-8");
    writeFileSync(join(repoDir, "yarn.lock"), "# yarn\n", "utf-8");

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot.lockfileHashes["package-lock.json"]).toBeDefined();
    expect(snapshot.lockfileHashes["yarn.lock"]).toBeDefined();
  });
});

describe("environment variable redaction", () => {
  it("never includes environment variable values in snapshot", () => {
    const repoDir = join(TEST_BASE, "env-redact");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });
    const serialized = JSON.stringify(snapshot);

    // envVarNames should only contain names, never values
    expect(snapshot.envVarNames).toBeInstanceOf(Array);
    for (const name of snapshot.envVarNames) {
      expect(typeof name).toBe("string");
      // Ensure it's a name, not a value (names are typically UPPER_CASE or path-like)
      expect(name).not.toContain("=");
    }

    // No known secret env var values should appear
    const secretVars = ["ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"];
    for (const key of secretVars) {
      const val = process.env[key];
      if (val && val.length > 4) {
        expect(serialized).not.toContain(val);
      }
    }
  });

  it("filters out vars with secret-related names", () => {
    const repoDir = join(TEST_BASE, "env-filter");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });

    for (const name of snapshot.envVarNames) {
      const upper = name.toUpperCase();
      expect(upper).not.toContain("SECRET");
      expect(upper).not.toContain("PASSWORD");
      expect(upper).not.toContain("CREDENTIAL");
    }
  });

  it("includes safe env var names like NODE_ENV and PATH", () => {
    const repoDir = join(TEST_BASE, "env-safe");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });

    // PATH should always be present
    expect(snapshot.envVarNames).toContain("PATH");
  });
});

describe("deterministic serialization", () => {
  it("produces valid JSON", () => {
    const repoDir = join(TEST_BASE, "json-valid");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });
    const serialized = JSON.stringify(snapshot, null, 2);

    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it("produces consistent structure across calls (excluding timestamp)", () => {
    const repoDir = join(TEST_BASE, "consistent");
    initGitRepo(repoDir);

    const snap1 = captureSnapshot({ cwd: repoDir });
    const snap2 = captureSnapshot({ cwd: repoDir });

    // Same structure, same values (except timestamp)
    expect(snap1.formatVersion).toBe(snap2.formatVersion);
    expect(snap1.repository.commit).toBe(snap2.repository.commit);
    expect(snap1.repository.dirty).toBe(snap2.repository.dirty);
    expect(snap1.platform).toEqual(snap2.platform);
    expect(snap1.runtimes).toEqual(snap2.runtimes);
    expect(snap1.lockfileHashes).toEqual(snap2.lockfileHashes);
  });

  it("includes all required top-level fields", () => {
    const repoDir = join(TEST_BASE, "fields");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });

    expect(snapshot).toHaveProperty("formatVersion");
    expect(snapshot).toHaveProperty("timestamp");
    expect(snapshot).toHaveProperty("repository");
    expect(snapshot).toHaveProperty("platform");
    expect(snapshot).toHaveProperty("runtimes");
    expect(snapshot).toHaveProperty("packageManager");
    expect(snapshot).toHaveProperty("lockfileHashes");
    expect(snapshot).toHaveProperty("agent");
    expect(snapshot).toHaveProperty("workdir");
    expect(snapshot).toHaveProperty("envVarNames");
  });
});

describe("writeSnapshot / readSnapshot", () => {
  it("round-trips through write and read", () => {
    const repoDir = join(TEST_BASE, "roundtrip-repo");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });
    const traceDir = join(TEST_BASE, "trace-out");

    writeSnapshot(traceDir, snapshot);
    const loaded = readSnapshot(traceDir);

    expect(loaded).toEqual(snapshot);
  });

  it("creates directory if it does not exist", () => {
    const traceDir = join(TEST_BASE, "new-dir", "deep", "path");

    const snapshot = captureSnapshot({ cwd: TEST_BASE });
    writeSnapshot(traceDir, snapshot);

    expect(existsSync(join(traceDir, "snapshot.json"))).toBe(true);
  });

  it("returns null for missing snapshot", () => {
    const result = readSnapshot(join(TEST_BASE, "nonexistent"));
    expect(result).toBeNull();
  });

  it("returns null for malformed snapshot file", () => {
    const traceDir = join(TEST_BASE, "malformed");
    mkdirSync(traceDir, { recursive: true });
    writeFileSync(join(traceDir, "snapshot.json"), "not json{{{", "utf-8");

    const result = readSnapshot(traceDir);
    expect(result).toBeNull();
  });
});

describe("formatSnapshot", () => {
  it("formats a clean repo snapshot", () => {
    const repoDir = join(TEST_BASE, "format-clean");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });
    const output = formatSnapshot(snapshot);

    expect(output).toContain("Repository");
    expect(output).toContain("commit:");
    expect(output).toContain("dirty:    no");
    expect(output).toContain("Environment");
    expect(output).toContain("platform:");
    expect(output).toContain("Agent");
    expect(output).toContain("Workdir");
  });

  it("formats a dirty repo snapshot", () => {
    const repoDir = join(TEST_BASE, "format-dirty");
    initGitRepo(repoDir);
    writeFileSync(join(repoDir, "dirty.txt"), "change\n", "utf-8");

    const snapshot = captureSnapshot({ cwd: repoDir });
    const output = formatSnapshot(snapshot);

    expect(output).toContain("dirty:    yes");
    expect(output).toContain("changed:");
  });

  it("formats agent information", () => {
    const snapshot: EnvironmentSnapshot = {
      formatVersion: "1.0.0",
      timestamp: new Date().toISOString(),
      repository: {
        root: "/tmp/test",
        commit: "abc1234567890",
        branch: "main",
        dirty: false,
        dirtyFileCount: 0,
        dirtyDiff: null,
        untrackedFiles: [],
      },
      platform: { os: "linux", arch: "x64", release: "6.0.0" },
      runtimes: { node: "22.4.0", npm: "10.8.0" },
      packageManager: { name: "npm", version: "10.8.0" },
      lockfileHashes: { "package-lock.json": "sha256:abc123" },
      agent: { name: "claude-code", version: "2.4.1", model: "claude-sonnet-4-20250514" },
      workdir: { absolute: "/tmp/test", relativeToRepo: "." },
      envVarNames: ["PATH", "NODE_ENV"],
    };

    const output = formatSnapshot(snapshot);

    expect(output).toContain("claude-code");
    expect(output).toContain("2.4.1");
    expect(output).toContain("claude-sonnet-4-20250514");
    expect(output).toContain("linux-x64");
    expect(output).toContain("node: 22.4.0");
    expect(output).toContain("npm: 10.8.0");
    expect(output).toContain("package-lock.json");
  });

  it("formats non-git directory", () => {
    const snapshot: EnvironmentSnapshot = {
      formatVersion: "1.0.0",
      timestamp: new Date().toISOString(),
      repository: {
        root: "/tmp/test",
        commit: null,
        branch: null,
        dirty: false,
        dirtyFileCount: 0,
        dirtyDiff: null,
        untrackedFiles: [],
      },
      platform: { os: "darwin", arch: "arm64", release: "23.0.0" },
      runtimes: {},
      packageManager: { name: null, version: null },
      lockfileHashes: {},
      agent: { name: null, version: null, model: null },
      workdir: { absolute: "/tmp/test", relativeToRepo: null },
      envVarNames: [],
    };

    const output = formatSnapshot(snapshot);

    expect(output).toContain("(not a git repository)");
    expect(output).toContain("(not detected)");
  });
});

describe("backward compatibility", () => {
  it("snapshot does not interfere with existing trace format", () => {
    const traceDir = join(TEST_BASE, "compat-trace");
    mkdirSync(traceDir, { recursive: true });

    // Write a legacy meta.json (no snapshot)
    const meta = {
      id: "r-test01",
      command: ["claude", "--print", "fix bug"],
      startTime: "2025-01-01T00:00:00Z",
      eventCount: 5,
      commit: "abc123",
      cwd: "/tmp/test",
    };
    writeFileSync(join(traceDir, "meta.json"), JSON.stringify(meta), "utf-8");
    writeFileSync(join(traceDir, "trace.json"), "[]", "utf-8");

    // Reading snapshot from a trace that doesn't have one returns null
    const snapshot = readSnapshot(traceDir);
    expect(snapshot).toBeNull();

    // Meta.json is untouched
    const loadedMeta = JSON.parse(readFileSync(join(traceDir, "meta.json"), "utf-8"));
    expect(loadedMeta).toEqual(meta);
  });

  it("snapshot can be added alongside existing trace data", () => {
    const traceDir = join(TEST_BASE, "compat-add");
    mkdirSync(traceDir, { recursive: true });

    // Existing trace files
    writeFileSync(join(traceDir, "meta.json"), '{"id":"r-test"}', "utf-8");
    writeFileSync(join(traceDir, "trace.json"), "[]", "utf-8");

    // Write snapshot alongside
    const repoDir = join(TEST_BASE, "compat-repo");
    initGitRepo(repoDir);
    const snapshot = captureSnapshot({ cwd: repoDir });
    writeSnapshot(traceDir, snapshot);

    // Both files coexist
    expect(existsSync(join(traceDir, "meta.json"))).toBe(true);
    expect(existsSync(join(traceDir, "trace.json"))).toBe(true);
    expect(existsSync(join(traceDir, "snapshot.json"))).toBe(true);

    // Meta untouched
    expect(JSON.parse(readFileSync(join(traceDir, "meta.json"), "utf-8"))).toEqual({ id: "r-test" });
  });
});

describe("snapshot format version", () => {
  it("is a valid semver string", () => {
    expect(SNAPSHOT_FORMAT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is embedded in every captured snapshot", () => {
    const repoDir = join(TEST_BASE, "version-repo");
    initGitRepo(repoDir);

    const snapshot = captureSnapshot({ cwd: repoDir });
    expect(snapshot.formatVersion).toBe(SNAPSHOT_FORMAT_VERSION);
  });
});

describe("snapshot size", () => {
  it("is small enough to commit to git", () => {
    const repoDir = join(TEST_BASE, "size-repo");
    initGitRepo(repoDir);
    writeFileSync(join(repoDir, "package-lock.json"), '{"v":1}\n', "utf-8");

    const snapshot = captureSnapshot({ cwd: repoDir });
    const serialized = JSON.stringify(snapshot, null, 2);

    // Should be well under 50KB
    expect(Buffer.byteLength(serialized, "utf-8")).toBeLessThan(50 * 1024);
  });
});
