import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { TraceReader } from "./trace.js";
import { ReplayProxy } from "./proxy.js";
import { createWorktree } from "./worktree.js";
import { evaluateAssertions } from "./assertions.js";
import { writeBlobIfNeeded, resolveBlob } from "./blob.js";
import { verify } from "./verify.js";
import { generateFixId } from "./id.js";
import type { AssertionDef, AssertionResult, TraceMeta } from "./types.js";

export const FIX_SESSION_FORMAT_VERSION = 1;

/**
 * Result of running the recorded reproduction against a worktree and
 * evaluating its assertions — the same computation `repro test <id>` does
 * for a single manifest entry. This is the *only* authoritative success
 * signal for `repro fix`.
 */
export interface ReproductionCheckResult {
  exitCode: number;
  divergences: Array<{ seq: number; expected: string; actual: string }>;
  assertionResults: AssertionResult[];
  passed: boolean;
}

export interface FailureBrief {
  id: string;
  title: string;
  assertionResults: AssertionResult[];
  divergenceCount: number;
  firstDivergenceSeq?: number;
  attemptNumber: number;
  maxAttempts: number;
}

export interface AgentResult {
  exitCode: number;
  elapsedMs: number;
  agentVersion?: string;
}

/**
 * Runs a coding agent against a failure brief inside an isolated worktree.
 * repro owns reproduction + verification; implementations of this interface
 * only propose changes to the worktree's files.
 */
export interface AgentRunner {
  readonly name: string;
  /** The command line used to invoke the agent, for the FixSession record. */
  readonly command: string[];
  run(
    brief: FailureBrief,
    worktreePath: string,
    env: Record<string, string>,
  ): Promise<AgentResult>;
}

export class AgentBinaryNotFoundError extends Error {
  constructor(public readonly binary: string) {
    super(`agent binary '${binary}' not found on PATH`);
    this.name = "AgentBinaryNotFoundError";
  }
}

export interface FixSession {
  formatVersion: number;
  fixId: string;
  reproductionId: string;
  title: string;
  sourceCommit: string;
  worktreePath: string;
  agentName: string;
  agentCommand: string[];
  agentVersion?: string;
  maxAttempts: number;
  attemptCount: number;
  status: "pending" | "verified" | "unverified" | "aborted";
  changedFiles: string[];
  diffStat: { insertions: number; deletions: number };
  baseline?: ReproductionCheckResult;
  finalResult?: ReproductionCheckResult;
  startTime: string;
  endTime?: string;
}

export interface FixAttempt {
  attemptNumber: number;
  changedFiles: string[];
  agentExitCode: number;
  agentElapsedMs: number;
  reproductionResult: ReproductionCheckResult | null;
  passed: boolean;
  blocked: boolean;
  startTime: string;
  endTime: string;
}

/** Base class for errors raised once a fix session (and worktree) exists. */
export class FixError extends Error {
  constructor(
    message: string,
    public readonly session: FixSession,
    public readonly attempts: FixAttempt[],
  ) {
    super(message);
    this.name = "FixError";
  }
}

export class BaselineNotFailingError extends FixError {}
export class ReproArtifactsModifiedError extends FixError {}
export class UnfixableAssertionsError extends FixError {}
export class AgentUnavailableError extends FixError {}

export interface FixOptions {
  id: string;
  traceDir: string;
  repoDir: string;
  title?: string;
  maxAttempts?: number;
  agentRunner?: AgentRunner;
  strict?: boolean;
}

export interface FixResult {
  session: FixSession;
  attempts: FixAttempt[];
}

/** The assertion types that are pure functions of the recorded trace and
 *  therefore cannot be affected by any change to the worktree's source
 *  files. Only `command` assertions (and replay divergence) are "live" —
 *  see docs/decisions/028-fix-loop-and-agent-runner.md. */
const FROZEN_ASSERTION_TYPES = new Set(["forbidden_path", "no_repeat", "max_calls"]);

/**
 * The default AgentRunner: spawns the Claude Code CLI in print mode with
 * the failure brief as the prompt, inside the isolated worktree.
 */
export class ClaudeCodeRunner implements AgentRunner {
  readonly name = "claude-code";
  readonly command: string[];

  constructor(private readonly binary: string = "claude") {
    this.command = [binary, "--print"];
  }

  async run(
    brief: FailureBrief,
    worktreePath: string,
    env: Record<string, string>,
  ): Promise<AgentResult> {
    const prompt = formatFailureBrief(brief);
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ["--print", prompt], {
        cwd: worktreePath,
        env: { ...process.env, ...env },
        stdio: "inherit",
      });

      child.on("exit", (code) => {
        resolve({
          exitCode: code ?? 1,
          elapsedMs: Date.now() - start,
          agentVersion: getAgentVersion(this.binary),
        });
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          reject(new AgentBinaryNotFoundError(this.binary));
        } else {
          reject(err);
        }
      });
    });
  }
}

function getAgentVersion(binary: string): string | undefined {
  try {
    const raw = execSync(`${binary} --version`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const match = raw.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : raw || undefined;
  } catch {
    return undefined;
  }
}

function formatAssertionLabel(assertion: AssertionDef): string {
  switch (assertion.type) {
    case "forbidden_path":
      return `forbidden_path: ${assertion.args.pattern}`;
    case "max_calls":
      return `max_calls: ${assertion.args.max}`;
    case "no_repeat":
      return `no_repeat: ${assertion.args.max}`;
    case "command":
      return `command: ${assertion.args.command}`;
    default:
      return String(assertion.type);
  }
}

export function formatFailureBrief(brief: FailureBrief): string {
  const lines: string[] = [];
  lines.push("REPRODUCTION FAILURE");
  lines.push("");
  lines.push(`ID: ${brief.id}`);
  lines.push(`Title: ${brief.title}`);

  const failing = brief.assertionResults.filter((r) => !r.passed);
  for (const r of failing) {
    lines.push(`Assertion: ${formatAssertionLabel(r.assertion)}`);
    lines.push(`Observed: ${r.message.split("\n")[0]}`);
  }

  if (brief.divergenceCount > 0) {
    const at =
      brief.firstDivergenceSeq !== undefined
        ? `, first at step ${brief.firstDivergenceSeq}`
        : "";
    lines.push(`Replay divergence: ${brief.divergenceCount} point(s)${at}`);
  }

  lines.push("Expected: The reproduction should replay with all assertions passing.");
  lines.push("");
  lines.push("Fix requirement:");
  lines.push("  Make the reproduction pass without weakening or removing the assertion.");
  lines.push("");
  lines.push("Constraints:");
  lines.push("  Do not modify the reproduction (.repro/ artifacts).");
  lines.push("  Do not weaken/remove assertions.");
  lines.push("  Work only inside the isolated worktree.");
  lines.push(`  Your fix is accepted only if \`repro test ${brief.id}\` passes.`);

  if (brief.attemptNumber > 1) {
    lines.push("");
    lines.push(`This is attempt ${brief.attemptNumber} of ${brief.maxAttempts}.`);
  }

  return lines.join("\n");
}

function buildFailureBrief(params: {
  id: string;
  title: string;
  result: ReproductionCheckResult;
  attemptNumber: number;
  maxAttempts: number;
}): FailureBrief {
  const { id, title, result, attemptNumber, maxAttempts } = params;
  return {
    id,
    title,
    assertionResults: result.assertionResults,
    divergenceCount: result.divergences.length,
    firstDivergenceSeq: result.divergences[0]?.seq,
    attemptNumber,
    maxAttempts,
  };
}

/**
 * Replays the recorded reproduction against `worktreePath` and evaluates
 * its assertions. This is exactly what `repro test <id>` does for one
 * manifest entry — deliberately duplicated rather than shared, matching
 * the fork.ts / bisect.ts precedent in this codebase.
 *
 * Assertions are always evaluated against `traceDir/assertions.json` (the
 * developer's original repo, never the worktree's own `.repro/` copy, if
 * one happens to exist there) and against the immutable recorded trace
 * events — an agent working inside the worktree structurally cannot weaken
 * or remove the assertions that judge it.
 */
export async function checkReproduction(
  traceDir: string,
  worktreePath: string,
  meta: TraceMeta,
  strict = true,
): Promise<ReproductionCheckResult> {
  const reader = new TraceReader(traceDir);

  const cwds = [worktreePath];
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
    childEnv.ANTHROPIC_API_KEY = "sk-repro-fix-dummy";
  }

  const cmd = meta.command;
  let exitCode: number;

  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(cmd[0], cmd.slice(1), {
        env: childEnv,
        stdio: "pipe",
        cwd: worktreePath,
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
  } finally {
    await proxy.stop();
  }

  const divergences = proxy.getDivergences();

  const assertionPath = join(traceDir, "assertions.json");
  let assertionResults: AssertionResult[] = [];
  if (existsSync(assertionPath)) {
    const assertions: AssertionDef[] = JSON.parse(
      readFileSync(assertionPath, "utf-8"),
    );
    const events = reader.readResolvedEvents();
    assertionResults = evaluateAssertions(assertions, events, worktreePath);
  }

  const passed =
    divergences.length === 0 && assertionResults.every((r) => r.passed);

  return { exitCode, divergences, assertionResults, passed };
}

/** Paths reported by `git status --porcelain`, resolving renames to their
 *  destination path. */
function gitStatusPaths(worktreePath: string): string[] {
  const out = execSync("git status --porcelain", {
    cwd: worktreePath,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const files: string[] = [];
  for (const raw of out.split("\n")) {
    if (!raw.trim()) continue;
    const rest = raw.slice(3);
    if (rest.includes(" -> ")) {
      files.push(rest.split(" -> ")[1].trim());
    } else {
      files.push(rest.trim().replace(/^"(.*)"$/, "$1"));
    }
  }
  return files;
}

/** Returns any changed paths under `.repro/` — the safety net that stops
 *  an agent from touching the reproduction it's being judged against. */
function findReproArtifactChanges(worktreePath: string): string[] {
  return gitStatusPaths(worktreePath).filter(
    (f) => f === ".repro" || f.startsWith(".repro/"),
  );
}

/**
 * Diffs the worktree against its checked-out commit, excluding any path in
 * `exclude` — paths written by the reproduction's own replay (e.g. tool
 * calls the recorded agent made), not by the fix agent. Without this, a
 * successful fix's reported diff would include the reproduction's own
 * side effects, which the developer never asked `repro fix` to touch.
 */
function computeDiffStat(
  worktreePath: string,
  exclude: ReadonlySet<string> = new Set(),
): {
  insertions: number;
  deletions: number;
  changedFiles: string[];
} {
  try {
    execSync("git add -A -N", {
      cwd: worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // best-effort — an empty/non-git worktree just reports no changes
  }

  let numstat = "";
  try {
    numstat = execSync("git diff --numstat", {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // ignore — treated as no changes
  }

  let insertions = 0;
  let deletions = 0;
  const changedFiles: string[] = [];

  for (const line of numstat.trim().split("\n")) {
    if (!line) continue;
    const [ins, del, file] = line.split("\t");
    if (!file || exclude.has(file)) continue;
    changedFiles.push(file);
    insertions += ins === "-" ? 0 : parseInt(ins, 10) || 0;
    deletions += del === "-" ? 0 : parseInt(del, 10) || 0;
  }

  return { insertions, deletions, changedFiles };
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeInitialSession(params: {
  fixId: string;
  id: string;
  title: string;
  commit: string;
  worktreePath: string;
  agentName: string;
  agentCommand: string[];
  maxAttempts: number;
}): FixSession {
  return {
    formatVersion: FIX_SESSION_FORMAT_VERSION,
    fixId: params.fixId,
    reproductionId: params.id,
    title: params.title,
    sourceCommit: params.commit,
    worktreePath: params.worktreePath,
    agentName: params.agentName,
    agentCommand: params.agentCommand,
    maxAttempts: params.maxAttempts,
    attemptCount: 0,
    status: "pending",
    changedFiles: [],
    diffStat: { insertions: 0, deletions: 0 },
    startTime: nowIso(),
  };
}

/**
 * Runs the full fix loop:
 *
 *   1. Verify the reproduction is runnable (`repro verify`).
 *   2. Create an isolated worktree at the recorded commit.
 *   3. Run the reproduction — confirm it currently fails (the baseline).
 *   4. Ask the AgentRunner to propose a fix, then re-run the reproduction.
 *   5. Repeat until it passes or `maxAttempts` is exhausted.
 *
 * The worktree is *never* removed by this function — win or lose, it's
 * left for the developer to inspect, diff, and decide whether to apply.
 */
export async function runFix(options: FixOptions): Promise<FixResult> {
  const { id, traceDir, repoDir } = options;
  const maxAttempts = options.maxAttempts ?? 3;
  const agentRunner = options.agentRunner ?? new ClaudeCodeRunner();
  const strict = options.strict ?? true;
  const title = options.title ?? "Untitled failure";

  let meta: TraceMeta;
  try {
    const reader = new TraceReader(traceDir);
    meta = reader.readMeta();
    reader.readEvents();
  } catch (err) {
    throw new Error(
      `repro fix: malformed reproduction ${id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const verifyResult = verify(id, traceDir, repoDir);
  if (!verifyResult.canReplay) {
    const failures = verifyResult.checks
      .filter((c) => c.status === "FAIL")
      .map((c) => `${c.name}: ${c.message}`);
    throw new Error(
      `repro fix: reproduction ${id} is not replayable:\n  ${failures.join("\n  ")}`,
    );
  }

  const worktreeInfo = createWorktree(repoDir, meta.commit);
  const fixId = generateFixId();

  const session = makeInitialSession({
    fixId,
    id,
    title,
    commit: worktreeInfo.commit,
    worktreePath: worktreeInfo.path,
    agentName: agentRunner.name,
    agentCommand: agentRunner.command,
    maxAttempts,
  });

  const attempts: FixAttempt[] = [];

  const baseline = await checkReproduction(
    traceDir,
    worktreeInfo.path,
    meta,
    strict,
  );
  session.baseline = baseline;

  // The baseline replay itself writes files into the worktree (whatever
  // tool calls the recorded, originally-failing agent made). Those are
  // side effects of the reproduction, not of the fix — exclude them from
  // every attempt's reported diff so `Diff: +N / -M` describes only what
  // the coding agent actually changed.
  const replayArtifacts = new Set(gitStatusPaths(worktreeInfo.path));

  if (baseline.passed) {
    session.status = "aborted";
    session.endTime = nowIso();
    writeFixSession(traceDir, session, attempts);
    throw new BaselineNotFailingError(
      `repro fix: baseline reproduction ${id} no longer fails — nothing to fix (worktree left at ${worktreeInfo.path})`,
      session,
      attempts,
    );
  }

  // `passed` requires ALL assertions to pass, so a single failing frozen
  // assertion (forbidden_path / max_calls / no_repeat) makes the overall
  // result permanently unreachable — regardless of whatever else is also
  // failing. Check for "any", not "only": a mix of one frozen failure and
  // one live failure is exactly as unfixable as an all-frozen failure.
  const hasFrozenFailure = baseline.assertionResults.some(
    (r) => !r.passed && FROZEN_ASSERTION_TYPES.has(r.assertion.type),
  );

  if (hasFrozenFailure) {
    session.status = "aborted";
    session.endTime = nowIso();
    writeFixSession(traceDir, session, attempts);
    throw new UnfixableAssertionsError(
      `repro fix: reproduction ${id} fails on one or more assertions evaluated purely from the ` +
        `recorded trace (forbidden_path / max_calls / no_repeat) — these can never change from a ` +
        `worktree code change, since replay serves the exact recorded model responses and events ` +
        `regardless of the source tree. Because verification requires every assertion to pass, no ` +
        `sequence of code changes can make this reproduction pass as-is. No attempts will be made. ` +
        `Add a \`command\` assertion that checks live behavior if this failure should be fixable ` +
        `(worktree left at ${worktreeInfo.path}).`,
      session,
      attempts,
    );
  }

  let verified = false;

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    const attemptStart = nowIso();
    const lastResult = attempts.length > 0
      ? attempts[attempts.length - 1].reproductionResult!
      : baseline;

    const brief = buildFailureBrief({
      id,
      title,
      result: lastResult,
      attemptNumber,
      maxAttempts,
    });

    let agentResult: AgentResult;
    try {
      agentResult = await agentRunner.run(brief, worktreeInfo.path, {});
    } catch (err) {
      session.attemptCount = attemptNumber - 1;
      session.status = "aborted";
      session.endTime = nowIso();
      writeFixSession(traceDir, session, attempts);
      throw new AgentUnavailableError(
        `repro fix: agent unavailable: ${err instanceof Error ? err.message : String(err)} ` +
          `(worktree left at ${worktreeInfo.path})`,
        session,
        attempts,
      );
    }

    session.attemptCount = attemptNumber;
    session.agentVersion = session.agentVersion ?? agentResult.agentVersion;

    const violations = findReproArtifactChanges(worktreeInfo.path);
    if (violations.length > 0) {
      const attempt: FixAttempt = {
        attemptNumber,
        changedFiles: violations,
        agentExitCode: agentResult.exitCode,
        agentElapsedMs: agentResult.elapsedMs,
        reproductionResult: null,
        passed: false,
        blocked: true,
        startTime: attemptStart,
        endTime: nowIso(),
      };
      attempts.push(attempt);
      session.status = "aborted";
      session.endTime = nowIso();
      writeFixSession(traceDir, session, attempts);
      throw new ReproArtifactsModifiedError(
        `repro fix: agent modified reproduction artifacts under .repro/ — fix aborted: ${violations.join(", ")} ` +
          `(worktree left at ${worktreeInfo.path})`,
        session,
        attempts,
      );
    }

    const reproductionResult = await checkReproduction(
      traceDir,
      worktreeInfo.path,
      meta,
      strict,
    );
    const diffStat = computeDiffStat(worktreeInfo.path, replayArtifacts);

    const attempt: FixAttempt = {
      attemptNumber,
      changedFiles: diffStat.changedFiles,
      agentExitCode: agentResult.exitCode,
      agentElapsedMs: agentResult.elapsedMs,
      reproductionResult,
      passed: reproductionResult.passed,
      blocked: false,
      startTime: attemptStart,
      endTime: nowIso(),
    };
    attempts.push(attempt);

    session.changedFiles = diffStat.changedFiles;
    session.diffStat = {
      insertions: diffStat.insertions,
      deletions: diffStat.deletions,
    };

    if (reproductionResult.passed) {
      verified = true;
      session.finalResult = reproductionResult;
      break;
    }
  }

  session.status = verified ? "verified" : "unverified";
  session.endTime = nowIso();
  writeFixSession(traceDir, session, attempts);

  return { session, attempts };
}

function writeFixSession(
  traceDir: string,
  session: FixSession,
  attempts: FixAttempt[],
): void {
  const fixDir = join(traceDir, "fixes", session.fixId);
  const blobDir = join(fixDir, "blobs");
  mkdirSync(fixDir, { recursive: true });

  const attemptsForWrite = attempts.map((a) => ({
    ...a,
    reproductionResult: a.reproductionResult
      ? writeBlobIfNeeded(a.reproductionResult, blobDir)
      : null,
  }));

  const sessionForWrite = {
    ...session,
    baseline: session.baseline
      ? writeBlobIfNeeded(session.baseline, blobDir)
      : undefined,
    finalResult: session.finalResult
      ? writeBlobIfNeeded(session.finalResult, blobDir)
      : undefined,
  };

  writeFileSync(
    join(fixDir, "session.json"),
    JSON.stringify(sessionForWrite, null, 2) + "\n",
    "utf-8",
  );
  writeFileSync(
    join(fixDir, "attempts.json"),
    JSON.stringify(attemptsForWrite, null, 2) + "\n",
    "utf-8",
  );
}

export function readFixSession(
  traceDir: string,
  fixId: string,
): { session: FixSession; attempts: FixAttempt[] } {
  const fixDir = join(traceDir, "fixes", fixId);
  const blobDir = join(fixDir, "blobs");

  const rawSession = JSON.parse(
    readFileSync(join(fixDir, "session.json"), "utf-8"),
  ) as FixSession;
  const rawAttempts = JSON.parse(
    readFileSync(join(fixDir, "attempts.json"), "utf-8"),
  ) as FixAttempt[];

  const session: FixSession = {
    ...rawSession,
    baseline: rawSession.baseline
      ? (resolveBlob(rawSession.baseline, blobDir) as ReproductionCheckResult)
      : undefined,
    finalResult: rawSession.finalResult
      ? (resolveBlob(rawSession.finalResult, blobDir) as ReproductionCheckResult)
      : undefined,
  };

  const attempts: FixAttempt[] = rawAttempts.map((a) => ({
    ...a,
    reproductionResult: a.reproductionResult
      ? (resolveBlob(a.reproductionResult, blobDir) as ReproductionCheckResult)
      : null,
  }));

  return { session, attempts };
}
