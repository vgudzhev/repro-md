import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { RecordingProxy } from "../src/proxy.js";
import { StubUpstream } from "../src/test-fixtures/stub-upstream.js";
import { TraceReader } from "../src/trace.js";
import { planFork, ForkProxy, executeFork } from "../src/fork.js";
import { removeWorktree } from "../src/worktree.js";

const TEST_BASE = join(
  import.meta.dirname,
  "..",
  ".test-fork-" + process.pid,
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
  prompt?: string,
): Promise<number> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        agentPath,
        prompt ??
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
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
}

async function recordTrace(
  testDir: string,
  traceId: string,
  responses?: typeof STANDARD_RESPONSES,
): Promise<void> {
  const stub = new StubUpstream({ responses: [...(responses ?? STANDARD_RESPONSES)] });
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

describe("planFork", () => {
  it("plans a fork at the first step", async () => {
    const id = "r-fork01";
    await recordTrace(TEST_BASE, id);

    const plan = planFork(reproDir(id), 1);
    expect(plan.replayCount).toBe(0);
    expect(plan.liveStartsAt).toBe(1);
    expect(plan.totalModelExchanges).toBe(3);
  }, 30000);

  it("plans a fork at a middle step", async () => {
    const id = "r-fork02";
    await recordTrace(TEST_BASE, id);

    const plan = planFork(reproDir(id), 2);
    expect(plan.replayCount).toBe(1);
    expect(plan.liveStartsAt).toBe(2);
  }, 30000);

  it("plans a fork at the final step", async () => {
    const id = "r-fork03";
    await recordTrace(TEST_BASE, id);

    const plan = planFork(reproDir(id), 3);
    expect(plan.replayCount).toBe(2);
    expect(plan.liveStartsAt).toBe(3);
  }, 30000);

  it("throws for --at beyond trace size", async () => {
    const id = "r-fork04";
    await recordTrace(TEST_BASE, id);

    expect(() => planFork(reproDir(id), 99)).toThrow(
      /must be between 1 and/,
    );
  }, 30000);

  it("throws for --at 0", async () => {
    const id = "r-fork05";
    await recordTrace(TEST_BASE, id);

    expect(() => planFork(reproDir(id), 0)).toThrow(
      /must be between 1 and/,
    );
  }, 30000);

  it("warns when commit is missing", async () => {
    const id = "r-fork06";
    await recordTrace(TEST_BASE, id);

    const metaPath = join(reproDir(id), "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    delete meta.commit;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");

    const plan = planFork(reproDir(id), 2);
    expect(plan.warnings.some((w) => w.includes("no commit recorded"))).toBe(true);
  }, 30000);
});

describe("ForkProxy", () => {
  it("replays N exchanges then serves 404 for subsequent requests", async () => {
    const id = "r-fprx01";
    await recordTrace(TEST_BASE, id);

    const proxy = new ForkProxy(
      reproDir(id),
      2,
      "http://127.0.0.1:1",
    );

    const port = await proxy.start();

    for (let i = 0; i < 2; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "dummy" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 100,
          messages: [{ role: "user", content: "test" }],
        }),
      });
      expect(response.ok).toBe(true);
    }

    expect(proxy.getReplaysServed()).toBe(2);

    await proxy.stop();
  }, 30000);

  it("replays zero exchanges (fork at step 1) and immediately forwards", async () => {
    const id = "r-fprx02";
    await recordTrace(TEST_BASE, id);

    const stub = new StubUpstream({
      responses: [
        {
          content: [{ type: "text", text: "live!" }],
          stop_reason: "end_turn",
        },
      ],
    });
    const stubPort = await stub.start();

    const proxy = new ForkProxy(
      reproDir(id),
      0,
      `http://127.0.0.1:${stubPort}`,
    );

    const port = await proxy.start();

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "dummy" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        messages: [{ role: "user", content: "test" }],
      }),
    });

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.content[0].text).toBe("live!");
    expect(proxy.getReplaysServed()).toBe(0);

    await proxy.stop();
    await stub.stop();
  }, 30000);
});

describe("executeFork", () => {
  it("replays N steps and runs live from the stub upstream", async () => {
    const id = "r-efork1";
    await recordTrace(TEST_BASE, id);

    const liveResponses = [
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_live_02",
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
            text: "Done from live!",
          },
        ],
        stop_reason: "end_turn",
      },
    ];

    const stub = new StubUpstream({ responses: [...liveResponses] });
    const stubPort = await stub.start();

    const result = await executeFork({
      traceDir: reproDir(id),
      forkAt: 2,
      repoDir: TEST_BASE,
      upstream: `http://127.0.0.1:${stubPort}`,
    });

    expect(result.replayedSteps).toBe(1);
    expect(result.worktreePath).toBeTruthy();
    expect(result.exitCode).toBe(0);

    removeWorktree(TEST_BASE, result.worktreePath);
    await stub.stop();
  }, 30000);

  it("reconstructs filesystem at recorded commit", async () => {
    const id = "r-efork2";
    await recordTrace(TEST_BASE, id);

    writeFileSync(join(TEST_BASE, "new-file.txt"), "added later", "utf-8");
    execSync("git add -A && git commit -m 'add new file'", {
      cwd: TEST_BASE,
      stdio: "pipe",
    });

    const liveResponses = [
      {
        content: [
          { type: "text", text: "Done!" },
        ],
        stop_reason: "end_turn",
      },
    ];

    const stub = new StubUpstream({ responses: [...liveResponses] });
    const stubPort = await stub.start();

    const result = await executeFork({
      traceDir: reproDir(id),
      forkAt: 3,
      repoDir: TEST_BASE,
      upstream: `http://127.0.0.1:${stubPort}`,
    });

    expect(result.replayedSteps).toBe(2);

    removeWorktree(TEST_BASE, result.worktreePath);
    await stub.stop();
  }, 30000);

  it("cleans up worktree on error", async () => {
    const id = "r-efork3";
    await recordTrace(TEST_BASE, id);

    const metaPath = join(reproDir(id), "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    meta.commit = "0000000000000000000000000000000000000000";
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");

    await expect(
      executeFork({
        traceDir: reproDir(id),
        forkAt: 2,
        repoDir: TEST_BASE,
      }),
    ).rejects.toThrow();
  }, 30000);
});

describe("fork: filesystem reconstruction", () => {
  it("worktree has the recorded commit's files", async () => {
    const id = "r-fsrec1";
    await recordTrace(TEST_BASE, id);

    writeFileSync(join(TEST_BASE, "extra.txt"), "extra", "utf-8");
    execSync("git add -A && git commit -m 'extra'", {
      cwd: TEST_BASE,
      stdio: "pipe",
    });

    const stub = new StubUpstream({
      responses: [
        { content: [{ type: "text", text: "Done!" }], stop_reason: "end_turn" },
      ],
    });
    const stubPort = await stub.start();

    const result = await executeFork({
      traceDir: reproDir(id),
      forkAt: 3,
      repoDir: TEST_BASE,
      upstream: `http://127.0.0.1:${stubPort}`,
    });

    expect(existsSync(join(result.worktreePath, "test-input.txt"))).toBe(true);

    removeWorktree(TEST_BASE, result.worktreePath);
    await stub.stop();
  }, 30000);
});

describe("fork: missing external state", () => {
  it("warns about external state limitations", async () => {
    const id = "r-extst1";
    await recordTrace(TEST_BASE, id);

    const plan = planFork(reproDir(id), 2);
    expect(plan.hasExternalState).toBe(false);
  }, 30000);
});

describe("fork: Windows path handling", () => {
  it("handles paths with backslashes in plan", async () => {
    const id = "r-winp01";
    await recordTrace(TEST_BASE, id);

    const plan = planFork(reproDir(id), 2);
    expect(plan.totalModelExchanges).toBe(3);
  }, 30000);
});
