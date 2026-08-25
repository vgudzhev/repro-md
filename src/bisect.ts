import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { TraceReader } from "./trace.js";
import { ReplayProxy } from "./proxy.js";
import { createWorktree, removeWorktree } from "./worktree.js";
import { evaluateAssertions } from "./assertions.js";
import type { AssertionDef } from "./types.js";

export type BisectVerdict = "GOOD" | "BAD" | "UNREPRODUCIBLE" | "ERROR";

export interface BisectCandidateResult {
  commit: string;
  verdict: BisectVerdict;
  message: string;
  divergences?: Array<{ seq: number; expected: string; actual: string }>;
  firstDivergence?: {
    step: number;
    expected: string;
    observed: string;
  };
}

export interface BisectResult {
  firstBad: string | null;
  candidates: BisectCandidateResult[];
  stepsEvaluated: number;
  totalCommits: number;
}

export interface BisectOptions {
  traceDir: string;
  repoDir: string;
  goodCommit: string;
  badCommit: string;
  strict?: boolean;
}

function resolveCommit(repoDir: string, ref: string): string {
  return execSync(`git rev-parse "${ref}"`, {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function getCommitsBetween(repoDir: string, good: string, bad: string): string[] {
  const log = execSync(
    `git rev-list --ancestry-path ${good}..${bad}`,
    { cwd: repoDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();

  if (!log) return [];
  return log.split("\n").reverse();
}

function isAncestor(repoDir: string, ancestor: string, descendant: string): boolean {
  try {
    execSync(`git merge-base --is-ancestor ${ancestor} ${descendant}`, {
      cwd: repoDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function validateBisectInputs(
  repoDir: string,
  goodCommit: string,
  badCommit: string,
): { good: string; bad: string; commits: string[] } {
  const good = resolveCommit(repoDir, goodCommit);
  const bad = resolveCommit(repoDir, badCommit);

  if (good === bad) {
    throw new Error("good and bad commits are the same");
  }

  if (!isAncestor(repoDir, good, bad)) {
    throw new Error(
      `${goodCommit} is not an ancestor of ${badCommit} — bisect requires the good commit to precede the bad one in the commit graph`,
    );
  }

  const commits = getCommitsBetween(repoDir, good, bad);
  if (commits.length === 0) {
    throw new Error("no commits found between good and bad");
  }

  return { good, bad, commits };
}

async function evaluateCandidate(
  commit: string,
  traceDir: string,
  repoDir: string,
  strict: boolean,
): Promise<BisectCandidateResult> {
  const reader = new TraceReader(traceDir);
  const meta = reader.readMeta();

  let worktreeInfo: { path: string; commit: string } | null = null;

  try {
    worktreeInfo = createWorktree(repoDir, commit);
  } catch (err) {
    return {
      commit,
      verdict: "ERROR",
      message: `failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const cwds = [worktreeInfo.path];
    if (meta.cwd) cwds.push(meta.cwd);

    const proxy = new ReplayProxy({ traceDir, strict, cwd: cwds });
    const port = await proxy.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...(meta.env ?? {}),
      ANTHROPIC_BASE_URL: baseUrl,
      OPENAI_BASE_URL: baseUrl,
    };

    if (meta.auth === "plan") {
      delete childEnv.ANTHROPIC_API_KEY;
      delete childEnv.OPENAI_API_KEY;
    } else {
      childEnv.ANTHROPIC_API_KEY = "sk-repro-bisect-dummy";
    }

    const cmd = meta.command;

    let exitCode: number;
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(cmd[0], cmd.slice(1), {
          env: childEnv,
          stdio: "pipe",
          cwd: worktreeInfo!.path,
        });

        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") {
            resolve(127);
          } else {
            reject(err);
          }
        });
      });
    } catch (err) {
      await proxy.stop();
      return {
        commit,
        verdict: "ERROR",
        message: `agent execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    await proxy.stop();

    if (exitCode === 127) {
      return {
        commit,
        verdict: "UNREPRODUCIBLE",
        message: `agent binary '${cmd[0]}' not found on PATH`,
      };
    }

    const divergences = proxy.getDivergences();

    const assertionPath = join(traceDir, "assertions.json");
    let assertionsFailed = false;
    let assertionMessage = "";

    if (existsSync(assertionPath)) {
      const assertions: AssertionDef[] = JSON.parse(
        readFileSync(assertionPath, "utf-8"),
      );
      const events = reader.readResolvedEvents();
      const results = evaluateAssertions(assertions, events, worktreeInfo.path);
      assertionsFailed = results.some((r) => !r.passed);
      if (assertionsFailed) {
        assertionMessage = results
          .filter((r) => !r.passed)
          .map((r) => r.message.split("\n")[0])
          .join("; ");
      }
    }

    if (divergences.length > 0) {
      const firstDiv = divergences[0];

      return {
        commit,
        verdict: "UNREPRODUCIBLE",
        message: `replay diverged at ${divergences.length} point(s)`,
        divergences,
        firstDivergence: {
          step: firstDiv.seq + 1,
          expected: firstDiv.expected,
          observed: firstDiv.actual,
        },
      };
    }

    if (assertionsFailed) {
      return {
        commit,
        verdict: "BAD",
        message: `assertion failed: ${assertionMessage}`,
      };
    }

    return {
      commit,
      verdict: "GOOD",
      message: "replay matched, assertions passed",
    };
  } finally {
    if (worktreeInfo) {
      removeWorktree(repoDir, worktreeInfo.path);
    }
  }
}

export async function bisect(options: BisectOptions): Promise<BisectResult> {
  const strict = options.strict ?? true;
  const { commits } = validateBisectInputs(
    options.repoDir,
    options.goodCommit,
    options.badCommit,
  );

  const candidates: BisectCandidateResult[] = [];
  const verdictCache = new Map<string, BisectVerdict>();

  let lo = 0;
  let hi = commits.length - 1;
  let firstBad: string | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = commits[mid];

    const cached = verdictCache.get(candidate);
    if (cached) {
      if (cached === "GOOD") {
        lo = mid + 1;
      } else if (cached === "BAD") {
        firstBad = candidate;
        hi = mid - 1;
      } else {
        break;
      }
      continue;
    }

    const result = await evaluateCandidate(
      candidate,
      options.traceDir,
      options.repoDir,
      strict,
    );

    candidates.push(result);
    verdictCache.set(candidate, result.verdict);

    if (result.verdict === "GOOD") {
      lo = mid + 1;
    } else if (result.verdict === "BAD") {
      firstBad = candidate;
      hi = mid - 1;
    } else {
      console.error(
        `repro: bisect: commit ${candidate.slice(0, 7)} is ${result.verdict}: ${result.message}`,
      );
      console.error(
        "repro: bisect: stopping — cannot reliably continue with unevaluable candidates",
      );
      break;
    }
  }

  return {
    firstBad,
    candidates,
    stepsEvaluated: candidates.length,
    totalCommits: commits.length,
  };
}
