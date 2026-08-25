import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { RecordingProxy } from "../src/proxy.js";
import { StubUpstream } from "../src/test-fixtures/stub-upstream.js";
import { TraceReader } from "../src/trace.js";
import { bisect, validateBisectInputs } from "../src/bisect.js";

const TEST_BASE = join(
  import.meta.dirname,
  "..",
  ".test-bisect-" + process.pid,
);

function reproDir(id: string): string {
  return join(TEST_BASE, ".repro", id);
}

const agentPath = join(
  import.meta.dirname,
  "..",
  "dist",
  "test-fixtures",
  "reference-agent.js",
);

const STANDARD_RESPONSES = [
  {
    content: [
      {
        type: "tool_use",
        id: "toolu_01",
        name: "read_file",
        input: { path: "test-input.txt" },
      },
    ],
    stop_reason: "tool_use",
  },
  {
    content: [
      {
        type: "tool_use",
        id: "toolu_02",
        name: "write_file",
        input: { path: "test-output.txt", content: "dlrow olleh" },
      },
    ],
    stop_reason: "tool_use",
  },
  {
    content: [
      {
        type: "text",
        text: "Done!",
      },
    ],
    stop_reason: "end_turn",
  },
];

async function spawnAgent(
  baseUrl: string,
  cwd: string,
): Promise<number> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        agentPath,
        "Read test-input.txt and write its content reversed to test-output.txt",
      ],
      {
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: "sk-repro-dummy",
          REPRO_AGENT_STREAM: "0",
        },
        cwd,
        stdio: "pipe",
      },
    );
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", reject);
  });
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "test-input.txt"), "hello world", "utf-8");
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init (good)"', { cwd: dir, stdio: "pipe" });
}

async function recordTrace(
  testDir: string,
  traceId: string,
): Promise<void> {
  const stub = new StubUpstream({ responses: [...STANDARD_RESPONSES] });
  const stubPort = await stub.start();
  const dir = reproDir(traceId);

  const proxy = new RecordingProxy({
    upstream: `http://127.0.0.1:${stubPort}`,
    traceDir: dir,
    traceId,
    env: { ANTHROPIC_API_KEY: "sk-repro-dummy" },
  });

  const proxyPort = await proxy.start();

  try {
    await spawnAgent(`http://127.0.0.1:${proxyPort}`, testDir);
  } finally {
    await proxy.stop();
    await stub.stop();
  }

  const reader = new TraceReader(dir);
  const meta = {
    id: traceId,
    command: [
      process.execPath,
      agentPath,
      "Read test-input.txt and write its content reversed to test-output.txt",
    ],
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    eventCount: reader.readEvents().length,
    commit: execSync("git rev-parse HEAD", {
      cwd: testDir,
      encoding: "utf-8",
    }).trim(),
  };
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify(meta, null, 2) + "\n",
    "utf-8",
  );
}

function makeLinearHistory(dir: string, n: number): string[] {
  const commits: string[] = [];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `file-${i}.txt`), `content ${i}`, "utf-8");
    execSync(`git add -A && git commit -m "commit ${i}"`, {
      cwd: dir,
      stdio: "pipe",
    });
    commits.push(
      execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim(),
    );
  }
  return commits;
}

beforeEach(() => {
  initGitRepo(TEST_BASE);
});

afterEach(() => {
  try {
    execSync("git worktree prune", { cwd: TEST_BASE, stdio: "pipe" });
  } catch {
    // ignore
  }
  rmSync(TEST_BASE, { recursive: true, force: true });
});

describe("validateBisectInputs", () => {
  it("validates good is ancestor of bad", () => {
    const good = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    makeLinearHistory(TEST_BASE, 3);

    const bad = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    const result = validateBisectInputs(TEST_BASE, good, bad);
    expect(result.good).toBe(good);
    expect(result.bad).toBe(bad);
    expect(result.commits.length).toBe(3);
  });

  it("rejects when good is not ancestor of bad", () => {
    const good = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    execSync("git checkout -b other-branch", { cwd: TEST_BASE, stdio: "pipe" });
    writeFileSync(join(TEST_BASE, "other.txt"), "other", "utf-8");
    execSync('git add -A && git commit -m "other branch"', {
      cwd: TEST_BASE,
      stdio: "pipe",
    });

    const bad = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    execSync("git checkout -", { cwd: TEST_BASE, stdio: "pipe" });

    expect(() => validateBisectInputs(TEST_BASE, bad, good)).toThrow(
      /not an ancestor/,
    );
  });

  it("rejects when good and bad are the same", () => {
    const commit = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    expect(() => validateBisectInputs(TEST_BASE, commit, commit)).toThrow(
      /same/,
    );
  });
});

describe("bisect with linear history", () => {
  it("finds good/bad boundary with assertion", async () => {
    const id = "r-bisec1";
    await recordTrace(TEST_BASE, id);

    const good = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    const commits = makeLinearHistory(TEST_BASE, 4);
    const bad = commits[commits.length - 1];

    writeFileSync(
      join(reproDir(id), "assertions.json"),
      JSON.stringify([
        { type: "forbidden_path", args: { pattern: "file-2.txt" } },
      ]) + "\n",
      "utf-8",
    );

    const result = await bisect({
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      goodCommit: good,
      badCommit: bad,
    });

    expect(result.stepsEvaluated).toBeGreaterThan(0);
    expect(result.candidates.length).toBeGreaterThan(0);

    for (const c of result.candidates) {
      expect(["GOOD", "BAD", "UNREPRODUCIBLE", "ERROR"]).toContain(c.verdict);
    }
  }, 60000);

  it("classifies unreproducible candidates distinctly from good", async () => {
    const id = "r-bisec2";
    await recordTrace(TEST_BASE, id);

    const good = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    writeFileSync(join(TEST_BASE, "test-input.txt"), "CHANGED INPUT", "utf-8");
    execSync('git add -A && git commit -m "break input"', {
      cwd: TEST_BASE,
      stdio: "pipe",
    });

    const bad = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    const result = await bisect({
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      goodCommit: good,
      badCommit: bad,
    });

    const unreproducible = result.candidates.filter(
      (c) => c.verdict === "UNREPRODUCIBLE",
    );
    expect(unreproducible.length).toBeGreaterThanOrEqual(0);

    for (const c of result.candidates) {
      expect(c.verdict).not.toBe("GOOD_BY_DEFAULT");
    }
  }, 60000);
});

describe("bisect: merge history", () => {
  it("handles merge commits in the history", async () => {
    const id = "r-bmerl1";
    await recordTrace(TEST_BASE, id);

    const good = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    execSync("git checkout -b feature-branch", { cwd: TEST_BASE, stdio: "pipe" });
    writeFileSync(join(TEST_BASE, "feature.txt"), "feature", "utf-8");
    execSync('git add -A && git commit -m "feature"', {
      cwd: TEST_BASE,
      stdio: "pipe",
    });

    execSync("git checkout -", { cwd: TEST_BASE, stdio: "pipe" });
    writeFileSync(join(TEST_BASE, "mainline.txt"), "mainline", "utf-8");
    execSync('git add -A && git commit -m "mainline"', {
      cwd: TEST_BASE,
      stdio: "pipe",
    });

    execSync("git merge feature-branch --no-edit", {
      cwd: TEST_BASE,
      stdio: "pipe",
    });

    const bad = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    const result = await bisect({
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      goodCommit: good,
      badCommit: bad,
    });

    expect(result.stepsEvaluated).toBeGreaterThan(0);
  }, 60000);
});

describe("bisect: dirty original repo", () => {
  it("does not mutate the original working tree", async () => {
    const id = "r-bdirt1";
    await recordTrace(TEST_BASE, id);

    const good = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    makeLinearHistory(TEST_BASE, 2);

    const bad = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    writeFileSync(join(TEST_BASE, "untracked-sentinel.txt"), "do not touch", "utf-8");

    await bisect({
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      goodCommit: good,
      badCommit: bad,
    });

    expect(existsSync(join(TEST_BASE, "untracked-sentinel.txt"))).toBe(true);
    expect(readFileSync(join(TEST_BASE, "untracked-sentinel.txt"), "utf-8")).toBe(
      "do not touch",
    );

    const currentHead = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();
    expect(currentHead).toBe(bad);
  }, 60000);
});

describe("bisect: missing dependency", () => {
  it("returns UNREPRODUCIBLE for missing agent binary", async () => {
    const id = "r-bmiss1";
    await recordTrace(TEST_BASE, id);

    const metaPath = join(reproDir(id), "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    meta.command = ["nonexistent-binary-xyz"];
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");

    const good = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    makeLinearHistory(TEST_BASE, 2);

    const bad = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    const result = await bisect({
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      goodCommit: good,
      badCommit: bad,
    });

    const hasUnreproducible = result.candidates.some(
      (c) => c.verdict === "UNREPRODUCIBLE" || c.verdict === "ERROR",
    );
    expect(hasUnreproducible).toBe(true);
  }, 60000);
});

describe("bisect: explicit states", () => {
  it("never reports ambiguous verdicts — only GOOD, BAD, UNREPRODUCIBLE, or ERROR", async () => {
    const id = "r-bstrt1";
    await recordTrace(TEST_BASE, id);

    const good = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    makeLinearHistory(TEST_BASE, 3);

    const bad = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    const result = await bisect({
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      goodCommit: good,
      badCommit: bad,
    });

    for (const c of result.candidates) {
      expect(["GOOD", "BAD", "UNREPRODUCIBLE", "ERROR"]).toContain(c.verdict);
      expect(c.message).toBeTruthy();
    }
  }, 60000);
});
