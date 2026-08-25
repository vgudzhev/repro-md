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
import { removeWorktree } from "../src/worktree.js";
import {
  runFix,
  checkReproduction,
  formatFailureBrief,
  readFixSession,
  BaselineNotFailingError,
  ReproArtifactsModifiedError,
  UnfixableAssertionsError,
  ClaudeCodeRunner,
  type AgentRunner,
  type AgentResult,
  type FailureBrief,
} from "../src/fix.js";
import type { AssertionDef } from "../src/types.js";

const TEST_BASE = join(
  import.meta.dirname,
  "..",
  ".test-fix-" + process.pid,
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

async function spawnAgent(baseUrl: string, cwd: string): Promise<number> {
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
  // The bug under test: bug-flag.txt starts out unfixed. The recorded
  // reproduction never touches this file, so a fix applied to it survives
  // deterministic replay untouched — this is the "live" (command-assertion)
  // surface a code change can actually affect.
  writeFileSync(join(dir, "bug-flag.txt"), "BUG\n", "utf-8");
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
}

async function recordTrace(
  testDir: string,
  traceId: string,
  assertions?: AssertionDef[],
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

  if (assertions) {
    writeFileSync(
      join(dir, "assertions.json"),
      JSON.stringify(assertions, null, 2) + "\n",
      "utf-8",
    );
  }
}

const BUG_FLAG_ASSERTION: AssertionDef = {
  type: "command",
  args: { command: "grep -q FIXED bug-flag.txt" },
};

/** A deterministic stand-in AgentRunner. `behaviors[i]` runs on the
 *  (i+1)-th call to `.run()`; the last behavior repeats if `.run()` is
 *  called more times than there are behaviors. */
class FakeAgentRunner implements AgentRunner {
  readonly name = "fake-agent";
  readonly command = ["fake-agent"];
  calls: Array<{ brief: FailureBrief; worktreePath: string }> = [];

  constructor(
    private readonly behaviors: Array<
      (worktreePath: string) => void | Promise<void>
    >,
    private readonly exitCodes: number[] = [],
  ) {}

  async run(
    brief: FailureBrief,
    worktreePath: string,
  ): Promise<AgentResult> {
    this.calls.push({ brief, worktreePath });
    const idx = Math.min(this.calls.length - 1, this.behaviors.length - 1);
    const start = Date.now();
    await this.behaviors[idx]?.(worktreePath);
    const exitCode = this.exitCodes[idx] ?? 0;
    return { exitCode, elapsedMs: Date.now() - start };
  }
}

function fixFile(worktreePath: string): void {
  writeFileSync(join(worktreePath, "bug-flag.txt"), "FIXED\n", "utf-8");
}

function noop(): void {
  // does nothing — simulates an agent that runs but makes no changes
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

describe("runFix: baseline", () => {
  it("aborts when the baseline reproduction does not currently fail", async () => {
    const id = "r-fixb01";
    // No assertions attached at all => baseline always "passes".
    await recordTrace(TEST_BASE, id);

    let thrown: unknown;
    try {
      await runFix({
        id,
        traceDir: reproDir(id),
        repoDir: TEST_BASE,
        agentRunner: new FakeAgentRunner([noop]),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(BaselineNotFailingError);
    const fixErr = thrown as BaselineNotFailingError;
    expect(fixErr.session.baseline?.passed).toBe(true);
    expect(fixErr.attempts).toHaveLength(0);

    removeWorktree(TEST_BASE, fixErr.session.worktreePath);
  }, 30000);

  it("aborts without running the agent when only frozen assertions fail", async () => {
    const id = "r-fixb02";
    await recordTrace(TEST_BASE, id, [
      { type: "forbidden_path", args: { pattern: "test-output.txt" } },
    ]);

    let ranAgent = false;
    let thrown: unknown;
    try {
      await runFix({
        id,
        traceDir: reproDir(id),
        repoDir: TEST_BASE,
        agentRunner: new FakeAgentRunner([
          () => {
            ranAgent = true;
          },
        ]),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UnfixableAssertionsError);
    expect(ranAgent).toBe(false);
    const fixErr = thrown as UnfixableAssertionsError;
    expect(fixErr.attempts).toHaveLength(0);

    removeWorktree(TEST_BASE, fixErr.session.worktreePath);
  }, 30000);

  it("aborts without running the agent when even one of several failing assertions is frozen", async () => {
    const id = "r-fixb03";
    // A mix: one live (command) assertion and one frozen (forbidden_path)
    // assertion both fail. Since `passed` requires ALL assertions to pass,
    // this is exactly as unfixable as the all-frozen case.
    await recordTrace(TEST_BASE, id, [
      BUG_FLAG_ASSERTION,
      { type: "forbidden_path", args: { pattern: "test-output.txt" } },
    ]);

    let ranAgent = false;
    let thrown: unknown;
    try {
      await runFix({
        id,
        traceDir: reproDir(id),
        repoDir: TEST_BASE,
        agentRunner: new FakeAgentRunner([
          () => {
            ranAgent = true;
          },
        ]),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UnfixableAssertionsError);
    expect(ranAgent).toBe(false);

    removeWorktree(TEST_BASE, (thrown as UnfixableAssertionsError).session.worktreePath);
  }, 30000);
});

describe("runFix: attempt loop", () => {
  it("records an attempt when the agent makes no changes and the reproduction still fails", async () => {
    const id = "r-fixa01";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);

    const runner = new FakeAgentRunner([noop]);
    const { session, attempts } = await runFix({
      id,
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      maxAttempts: 1,
      agentRunner: runner,
    });

    expect(session.status).toBe("unverified");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].passed).toBe(false);
    expect(attempts[0].reproductionResult?.passed).toBe(false);

    removeWorktree(TEST_BASE, session.worktreePath);
  }, 30000);

  it("verifies on the second attempt when the first fails and the second fixes it", async () => {
    const id = "r-fixa02";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);

    const runner = new FakeAgentRunner([noop, fixFile]);
    const { session, attempts } = await runFix({
      id,
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      maxAttempts: 3,
      agentRunner: runner,
    });

    expect(session.status).toBe("verified");
    expect(session.attemptCount).toBe(2);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].passed).toBe(false);
    expect(attempts[1].passed).toBe(true);
    expect(session.finalResult?.passed).toBe(true);

    removeWorktree(TEST_BASE, session.worktreePath);
  }, 60000);

  it("reports unverified after exhausting max attempts", async () => {
    const id = "r-fixa03";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);

    const runner = new FakeAgentRunner([noop, noop, noop]);
    const { session, attempts } = await runFix({
      id,
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      maxAttempts: 3,
      agentRunner: runner,
    });

    expect(session.status).toBe("unverified");
    expect(session.attemptCount).toBe(3);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => !a.passed)).toBe(true);

    removeWorktree(TEST_BASE, session.worktreePath);
  }, 60000);

  it("tracks multiple attempts in order with correct attempt numbers", async () => {
    const id = "r-fixa04";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);

    const runner = new FakeAgentRunner([noop, noop, fixFile]);
    const { session, attempts } = await runFix({
      id,
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      maxAttempts: 3,
      agentRunner: runner,
    });

    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
    expect(session.status).toBe("verified");
    expect(session.attemptCount).toBe(3);

    removeWorktree(TEST_BASE, session.worktreePath);
  }, 60000);

  it("records the agent's exit code for each attempt, including non-zero", async () => {
    const id = "r-fixa05";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);

    const runner = new FakeAgentRunner([noop], [17]);
    const { attempts, session } = await runFix({
      id,
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      maxAttempts: 1,
      agentRunner: runner,
    });

    expect(attempts[0].agentExitCode).toBe(17);

    removeWorktree(TEST_BASE, session.worktreePath);
  }, 30000);
});

describe("runFix: successful fix diff", () => {
  it("reports the changed file and a non-zero insertion count", async () => {
    const id = "r-fixd01";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);

    const runner = new FakeAgentRunner([fixFile]);
    const { session } = await runFix({
      id,
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      maxAttempts: 1,
      agentRunner: runner,
    });

    expect(session.status).toBe("verified");
    // Excludes files the reproduction's own replay wrote (test-output.txt)
    // — only the agent's actual fix should be reported.
    expect(session.changedFiles).toEqual(["bug-flag.txt"]);
    expect(session.diffStat.insertions).toBeGreaterThan(0);

    removeWorktree(TEST_BASE, session.worktreePath);
  }, 30000);
});

describe("runFix: assertions cannot be weakened", () => {
  it("evaluates against the original assertions.json regardless of what's in the worktree", async () => {
    const id = "r-fixw01";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);

    const traceDir = reproDir(id);
    const meta = JSON.parse(
      readFileSync(join(traceDir, "meta.json"), "utf-8"),
    );

    const { createWorktree, removeWorktree: rmWt } = await import(
      "../src/worktree.js"
    );
    const worktreeInfo = createWorktree(TEST_BASE, meta.commit);

    // Simulate an agent trying to weaken the assertion inside its own
    // isolated worktree copy — this must have zero effect on the result.
    mkdirSync(join(worktreeInfo.path, ".repro", id), { recursive: true });
    writeFileSync(
      join(worktreeInfo.path, ".repro", id, "assertions.json"),
      "[]\n",
      "utf-8",
    );

    const result = await checkReproduction(
      traceDir,
      worktreeInfo.path,
      meta,
      true,
    );

    expect(result.assertionResults).toHaveLength(1);
    expect(result.assertionResults[0].assertion.type).toBe("command");
    expect(result.passed).toBe(false);

    rmWt(TEST_BASE, worktreeInfo.path);
  }, 30000);
});

describe("runFix: guard against modifying reproduction artifacts", () => {
  it("blocks the fix when the agent modifies files under .repro/", async () => {
    const id = "r-fixg01";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);

    // Commit the .repro/<id> artifacts so they're tracked in the worktree
    // checkout — the realistic case where a reproduction was already saved
    // before a later regression is being fixed against that same commit.
    execSync("git add -A .repro", { cwd: TEST_BASE, stdio: "pipe" });
    execSync('git commit -m "commit repro artifacts"', {
      cwd: TEST_BASE,
      stdio: "pipe",
    });
    const newCommit = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    const metaPath = join(reproDir(id), "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    meta.commit = newCommit;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");

    const runner = new FakeAgentRunner([
      (worktreePath: string) => {
        writeFileSync(
          join(worktreePath, ".repro", id, "assertions.json"),
          "[]\n",
          "utf-8",
        );
      },
    ]);

    let thrown: unknown;
    try {
      await runFix({
        id,
        traceDir: reproDir(id),
        repoDir: TEST_BASE,
        maxAttempts: 3,
        agentRunner: runner,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ReproArtifactsModifiedError);
    const fixErr = thrown as ReproArtifactsModifiedError;
    expect(fixErr.session.status).toBe("aborted");
    expect(fixErr.attempts).toHaveLength(1);
    expect(fixErr.attempts[0].blocked).toBe(true);

    removeWorktree(TEST_BASE, fixErr.session.worktreePath);
  }, 30000);
});

describe("runFix: developer working tree is untouched", () => {
  it("leaves the current working tree unmodified", async () => {
    const id = "r-fixt01";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);

    writeFileSync(
      join(TEST_BASE, "untracked-sentinel.txt"),
      "do not touch",
      "utf-8",
    );

    const beforeHead = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();

    const runner = new FakeAgentRunner([fixFile]);
    const { session } = await runFix({
      id,
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      maxAttempts: 1,
      agentRunner: runner,
    });

    expect(
      readFileSync(join(TEST_BASE, "untracked-sentinel.txt"), "utf-8"),
    ).toBe("do not touch");
    expect(readFileSync(join(TEST_BASE, "bug-flag.txt"), "utf-8")).toBe(
      "BUG\n",
    );
    const afterHead = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();
    expect(afterHead).toBe(beforeHead);

    removeWorktree(TEST_BASE, session.worktreePath);
  }, 30000);
});

describe("runFix: error handling", () => {
  it("throws for a malformed reproduction", async () => {
    const id = "r-fixe01";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);
    writeFileSync(join(reproDir(id), "trace.json"), "{not valid json", "utf-8");

    await expect(
      runFix({
        id,
        traceDir: reproDir(id),
        repoDir: TEST_BASE,
        agentRunner: new FakeAgentRunner([noop]),
      }),
    ).rejects.toThrow(/malformed reproduction/);
  }, 30000);

  it("throws when the agent binary is missing", async () => {
    const id = "r-fixe02";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);

    await expect(
      runFix({
        id,
        traceDir: reproDir(id),
        repoDir: TEST_BASE,
        agentRunner: new ClaudeCodeRunner("nonexistent-coding-agent-xyz"),
      }),
    ).rejects.toThrow(/agent unavailable|not found on PATH/);
  }, 30000);
});

describe("formatFailureBrief", () => {
  it("renders a concise structured brief, not a raw trace dump", () => {
    const brief: FailureBrief = {
      id: "r-7f3a91",
      title: "Agent modifies generated files",
      assertionResults: [
        {
          assertion: { type: "forbidden_path", args: { pattern: "src/generated/**" } },
          passed: false,
          message: "Forbidden path src/generated/** matched:\n  seq 3: model.response touched src/generated/user_pb.ts",
        },
      ],
      divergenceCount: 0,
      attemptNumber: 1,
      maxAttempts: 3,
    };

    const text = formatFailureBrief(brief);

    expect(text).toContain("REPRODUCTION FAILURE");
    expect(text).toContain("ID: r-7f3a91");
    expect(text).toContain("forbidden_path: src/generated/**");
    expect(text).toContain("repro test r-7f3a91");
    expect(text).toContain("Do not modify the reproduction");
    expect(text.length).toBeLessThan(1500);
  });
});

describe("runFix: fix session persistence", () => {
  it("writes a versioned session and attempts record reuseable via blobs", async () => {
    const id = "r-fixs01";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);

    const runner = new FakeAgentRunner([noop, fixFile]);
    const { session, attempts } = await runFix({
      id,
      traceDir: reproDir(id),
      repoDir: TEST_BASE,
      maxAttempts: 3,
      agentRunner: runner,
    });

    const fixDir = join(reproDir(id), "fixes", session.fixId);
    expect(existsSync(join(fixDir, "session.json"))).toBe(true);
    expect(existsSync(join(fixDir, "attempts.json"))).toBe(true);

    const { session: readSession, attempts: readAttempts } = readFixSession(
      reproDir(id),
      session.fixId,
    );
    expect(readSession.formatVersion).toBe(1);
    expect(readSession.status).toBe("verified");
    expect(readSession.agentName).toBe("fake-agent");
    expect(readSession.agentCommand).toEqual(["fake-agent"]);
    expect(readAttempts).toHaveLength(attempts.length);
    expect(readAttempts[1].passed).toBe(true);

    removeWorktree(TEST_BASE, session.worktreePath);
  }, 60000);
});

describe("runFix: end-to-end via repro test equivalent", () => {
  it("known failure -> repro fix -> apply fix -> repro test passes", async () => {
    const id = "r-fixe2e";
    await recordTrace(TEST_BASE, id, [BUG_FLAG_ASSERTION]);

    // Confirm the known failure reproduces before any fix exists.
    const traceDir = reproDir(id);
    const meta = JSON.parse(readFileSync(join(traceDir, "meta.json"), "utf-8"));
    const { createWorktree, removeWorktree: rmWt } = await import(
      "../src/worktree.js"
    );
    const preWorktree = createWorktree(TEST_BASE, meta.commit);
    const preResult = await checkReproduction(traceDir, preWorktree.path, meta, true);
    expect(preResult.passed).toBe(false);
    rmWt(TEST_BASE, preWorktree.path);

    // Run repro fix with a fake agent that fixes the bug.
    const runner = new FakeAgentRunner([fixFile]);
    const { session } = await runFix({
      id,
      traceDir,
      repoDir: TEST_BASE,
      maxAttempts: 1,
      agentRunner: runner,
    });
    expect(session.status).toBe("verified");

    // The fix lives only in the isolated worktree — nothing is committed
    // to the developer's repo automatically. Simulate the developer
    // reviewing and applying the diff themselves.
    const fixedContent = readFileSync(
      join(session.worktreePath, "bug-flag.txt"),
      "utf-8",
    );
    writeFileSync(join(TEST_BASE, "bug-flag.txt"), fixedContent, "utf-8");
    execSync("git add -A && git commit -m 'apply fix from repro fix'", {
      cwd: TEST_BASE,
      stdio: "pipe",
    });

    // Now `repro test` (checkReproduction against a fresh worktree at the
    // new commit) must pass — the ONLY authoritative success signal.
    const newCommit = execSync("git rev-parse HEAD", {
      cwd: TEST_BASE,
      encoding: "utf-8",
    }).trim();
    const postWorktree = createWorktree(TEST_BASE, newCommit);
    const postResult = await checkReproduction(
      traceDir,
      postWorktree.path,
      { ...meta, commit: newCommit },
      true,
    );
    expect(postResult.passed).toBe(true);
    expect(postResult.assertionResults.every((r) => r.passed)).toBe(true);

    rmWt(TEST_BASE, postWorktree.path);
    removeWorktree(TEST_BASE, session.worktreePath);
  }, 60000);
});
