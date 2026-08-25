#!/usr/bin/env node

import { execSync, spawn } from "node:child_process";
import { join } from "node:path";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  cpSync,
  rmSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { RecordingProxy, ReplayProxy } from "./proxy.js";
import { generateTraceId } from "./id.js";
import { createWorktree, removeWorktree } from "./worktree.js";
import { TraceReader } from "./trace.js";
import { evaluateAssertions } from "./assertions.js";
import {
  scaffoldRepro,
  addEntry,
  readManifest,
} from "./manifest.js";
import { alignTraces, explainDivergence } from "./diff.js";
import { minimize } from "./minimize.js";
import type { AssertionDef, AnthropicRequest, TraceMeta } from "./types.js";
import { createLiveOracle, estimateCostPerCall } from "./oracle.js";
import {
  startDaemon,
  stopDaemon,
  daemonStatus,
  daemonRun,
  getTracesDir,
} from "./daemon.js";
import { listDaemonTraces } from "./retention.js";
import { verify, formatVerifyResult, formatVerifyJson } from "./verify.js";

function findTraceDir(
  id: string,
): { dir: string; source: "repo" | "daemon" } | null {
  const repoDir = join(process.cwd(), ".repro", id);
  if (existsSync(repoDir)) return { dir: repoDir, source: "repo" };

  const daemonDir = join(getTracesDir(), id);
  if (existsSync(daemonDir)) return { dir: daemonDir, source: "daemon" };

  return null;
}

export interface RecordFlags {
  model?: string;
  auth?: "plan" | "credits";
  cmd: string[];
}

export function parseRecordFlags(args: string[]): RecordFlags {
  const dashDash = args.indexOf("--");
  if (dashDash === -1 || dashDash === args.length - 1) {
    throw new Error("Usage: repro record [--model <name>] [--auth plan|credits] -- <command> [args...]");
  }

  const flagArgs = args.slice(0, dashDash);
  const cmd = args.slice(dashDash + 1);

  let model: string | undefined;
  let auth: "plan" | "credits" | undefined;

  for (let i = 0; i < flagArgs.length; i++) {
    if (flagArgs[i] === "--model" && flagArgs[i + 1]) {
      model = flagArgs[++i];
    } else if (flagArgs[i] === "--auth" && flagArgs[i + 1]) {
      const val = flagArgs[++i];
      if (val !== "plan" && val !== "credits") {
        throw new Error(`--auth must be "plan" or "credits", got "${val}"`);
      }
      auth = val;
    } else {
      throw new Error(`unknown flag: ${flagArgs[i]}`);
    }
  }

  return { model, auth, cmd };
}

async function recordCommand(args: string[]): Promise<void> {
  let flags: RecordFlags;
  try {
    flags = parseRecordFlags(args);
  } catch (err) {
    console.error(`repro: ${(err as Error).message}`);
    process.exit(1);
  }

  const { model: recordModel, auth: recordAuth, cmd } = flags;

  if (recordAuth === "credits" && !process.env.ANTHROPIC_API_KEY) {
    console.error("repro: --auth credits requires ANTHROPIC_API_KEY to be set");
    process.exit(1);
  }

  const traceId = generateTraceId();
  const reproDir = join(process.cwd(), ".repro", traceId);

  const upstream =
    process.env.REPRO_UPSTREAM ?? "https://api.anthropic.com";

  const proxy = new RecordingProxy({
    upstream,
    traceDir: reproDir,
    traceId,
    cwd: process.cwd(),
  });

  const port = await proxy.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.error(`repro: recording ${traceId}`);
  if (recordModel) console.error(`repro: model=${recordModel}`);
  if (recordAuth) console.error(`repro: auth=${recordAuth}`);
  console.error(`repro: proxy listening on ${baseUrl}`);

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    OPENAI_BASE_URL: baseUrl,
  };

  if (recordAuth === "plan") {
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.OPENAI_API_KEY;
  }

  if (recordModel && !cmd.some(a => a === "--model" || a.startsWith("--model="))) {
    cmd.push("--model", recordModel);
  }

  const child = spawn(cmd[0], cmd.slice(1), {
    env: childEnv,
    stdio: "inherit",
    cwd: process.cwd(),
  });

  const startTime = new Date().toISOString();
  const traceWriter = proxy.getTraceWriter();
  traceWriter.append("process.start", {
    command: cmd,
    pid: child.pid,
  });

  child.on("exit", async (code, signal) => {
    traceWriter.append("process.exit", {
      code,
      signal,
    });

    await proxy.stop();

    let commit: string | undefined;
    try {
      commit = execSync("git rev-parse HEAD", {
        cwd: process.cwd(),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      // not a git repo — commit stays undefined
    }

    const agentEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("REPRO_") && value) {
        agentEnv[key] = value;
      }
    }

    const meta: TraceMeta = {
      id: traceId,
      command: cmd,
      startTime,
      endTime: new Date().toISOString(),
      eventCount: traceWriter.getEventCount(),
      commit,
      cwd: process.cwd(),
      ...(Object.keys(agentEnv).length > 0 ? { env: agentEnv } : {}),
      ...(recordModel ? { model: recordModel } : {}),
      ...(recordAuth ? { auth: recordAuth } : {}),
    };
    traceWriter.writeMeta(meta);

    console.error(
      `repro: ${code === 0 ? "completed" : "agent failed"} after ${meta.eventCount} events`,
    );
    console.error(`repro: saved ${traceId}`);

    process.exit(code ?? 1);
  });

  child.on("error", async (err) => {
    console.error(`repro: failed to start command: ${err.message}`);
    await proxy.stop();
    process.exit(1);
  });
}

async function runCommand(args: string[]): Promise<void> {
  const strict = !args.includes("--lenient");
  const id = args.find((a) => !a.startsWith("--"));

  if (!id) {
    console.error("Usage: repro run <id> [--strict|--lenient]");
    process.exit(1);
  }

  const traceDir = join(process.cwd(), ".repro", id);
  if (!existsSync(traceDir)) {
    console.error(`repro: trace ${id} not found at ${traceDir}`);
    process.exit(1);
  }

  const reader = new TraceReader(traceDir);
  const meta = reader.readMeta();
  const repoDir = process.cwd();

  console.error(`repro: replaying ${id} (${meta.eventCount} events)`);
  console.error(`repro: mode: ${strict ? "strict" : "lenient"}`);

  let worktreeInfo: { path: string; commit: string } | null = null;

  try {
    worktreeInfo = createWorktree(repoDir, meta.commit);
    console.error(`repro: worktree at ${worktreeInfo.path}`);

    const cwds = [worktreeInfo.path];
    if (meta.cwd) cwds.push(meta.cwd);

    const proxy = new ReplayProxy({
      traceDir,
      strict,
      cwd: cwds,
    });

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
      childEnv.ANTHROPIC_API_KEY = "sk-repro-replay-dummy";
    }

    const cmd = meta.command;

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(cmd[0], cmd.slice(1), {
        env: childEnv,
        stdio: "inherit",
        cwd: worktreeInfo!.path,
      });

      child.on("exit", (code) => resolve(code ?? 1));
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          console.error(`repro: error: agent binary '${cmd[0]}' not found on PATH`);
          console.error(`repro: install it or adjust the recording's meta.json command`);
          resolve(127);
        } else {
          reject(err);
        }
      });
    });

    await proxy.stop();

    const divergences = proxy.getDivergences();

    const assertionPath = join(traceDir, "assertions.json");
    let assertionResults: Array<{ passed: boolean; message: string }> = [];
    if (existsSync(assertionPath)) {
      const assertions: AssertionDef[] = JSON.parse(
        readFileSync(assertionPath, "utf-8"),
      );
      const events = reader.readResolvedEvents();
      assertionResults = evaluateAssertions(
        assertions,
        events,
        worktreeInfo.path,
      );
    }

    if (divergences.length === 0) {
      console.error(
        `repro: ✓ reproduced — ${meta.eventCount} events, 0 API calls, 0 API keys`,
      );
    } else {
      console.error(
        `repro: ✗ diverged at ${divergences.length} point(s)`,
      );
      for (const d of divergences) {
        console.error(
          `  seq ${d.seq}: expected ${d.expected}, got ${d.actual}`,
        );
      }
    }

    for (const r of assertionResults) {
      console.error(
        `repro: ${r.passed ? "✓" : "✗"} assertion: ${r.message.split("\n")[0]}`,
      );
    }

    removeWorktree(repoDir, worktreeInfo.path);
    worktreeInfo = null;
    console.error("repro: ✓ working tree restored");

    const anyFailed =
      assertionResults.some((r) => !r.passed) ||
      (divergences.length > 0 && strict);

    process.exit(anyFailed ? 1 : exitCode);
  } catch (err) {
    if (worktreeInfo) {
      removeWorktree(repoDir, worktreeInfo.path);
    }
    console.error(
      `repro: error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

function initCommand(): void {
  scaffoldRepro(process.cwd());
  console.error("repro: initialized .repro/ and REPRO.md");
  console.error("repro: next steps:");
  console.error("  1. repro record -- <your-agent-command>");
  console.error("  2. repro save <id> --title 'description'");
  console.error("  3. git add REPRO.md .repro/ && git commit");
}

function saveCommand(args: string[]): void {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("Usage: repro save <id> --title 'description' [--assertion type:pattern]");
    process.exit(1);
  }

  const found = findTraceDir(id);
  if (!found) {
    console.error(`repro: trace ${id} not found`);
    process.exit(1);
  }

  let traceDir = found.dir;

  if (found.source === "daemon") {
    const repoTraceDir = join(process.cwd(), ".repro", id);
    mkdirSync(join(process.cwd(), ".repro"), { recursive: true });
    try {
      renameSync(found.dir, repoTraceDir);
    } catch {
      cpSync(found.dir, repoTraceDir, { recursive: true });
      rmSync(found.dir, { recursive: true, force: true });
    }
    traceDir = repoTraceDir;
    console.error(`repro: moved daemon trace to .repro/${id}`);
  }

  const titleIdx = args.indexOf("--title");
  const title =
    titleIdx >= 0 && args[titleIdx + 1]
      ? args[titleIdx + 1]
      : "Untitled failure";

  const assertions: AssertionDef[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--assertion" && args[i + 1]) {
      const [type, ...rest] = args[i + 1].split(":");
      const pattern = rest.join(":");
      if (type === "forbidden_path") {
        assertions.push({ type: "forbidden_path", args: { pattern } });
      } else if (type === "max_calls") {
        assertions.push({ type: "max_calls", args: { max: parseInt(pattern) } });
      } else if (type === "no_repeat") {
        assertions.push({ type: "no_repeat", args: { max: parseInt(pattern) } });
      } else if (type === "command") {
        assertions.push({ type: "command", args: { command: pattern } });
      }
    }
  }

  if (assertions.length > 0) {
    writeFileSync(
      join(traceDir, "assertions.json"),
      JSON.stringify(assertions, null, 2) + "\n",
      "utf-8",
    );
  }

  const today = new Date().toISOString().split("T")[0];
  addEntry(process.cwd(), { id, title, status: "open", firstSeen: today });

  console.error(`repro: saved ${id} — "${title}"`);
  console.error("repro: added to REPRO.md");
}

async function testCommand(): Promise<void> {
  const entries = readManifest(process.cwd());
  const openEntries = entries.filter((e) => e.status === "open");

  if (openEntries.length === 0) {
    console.error("repro: no open failures to test");
    process.exit(0);
  }

  let passed = 0;
  let failed = 0;
  let diverged = 0;

  for (const entry of openEntries) {
    const traceDir = join(process.cwd(), ".repro", entry.id);
    if (!existsSync(traceDir)) {
      console.error(`repro: ✗ ${entry.id} — trace not found`);
      failed++;
      continue;
    }

    const reader = new TraceReader(traceDir);
    const meta = reader.readMeta();
    const repoDir = process.cwd();

    let worktreeInfo: { path: string; commit: string } | null = null;

    try {
      worktreeInfo = createWorktree(repoDir, meta.commit);

      const testCwds = [worktreeInfo.path];
      if (meta.cwd) testCwds.push(meta.cwd);
      const proxy = new ReplayProxy({ traceDir, strict: true, cwd: testCwds });
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
        childEnv.ANTHROPIC_API_KEY = "sk-repro-test-dummy";
      }

      await new Promise<number>((resolve, reject) => {
        const child = spawn(meta.command[0], meta.command.slice(1), {
          env: childEnv,
          stdio: "pipe",
          cwd: worktreeInfo!.path,
        });
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") {
            console.error(`repro: error: agent binary '${meta.command[0]}' not found on PATH`);
            resolve(127);
          } else {
            reject(err);
          }
        });
      });

      await proxy.stop();

      const divergences = proxy.getDivergences();
      const assertionPath = join(traceDir, "assertions.json");
      let assertionsFailed = false;

      if (existsSync(assertionPath)) {
        const assertions: AssertionDef[] = JSON.parse(
          readFileSync(assertionPath, "utf-8"),
        );
        const events = reader.readResolvedEvents();
        const results = evaluateAssertions(
          assertions,
          events,
          worktreeInfo.path,
        );
        assertionsFailed = results.some((r) => !r.passed);

        for (const r of results) {
          if (!r.passed) {
            console.error(
              `repro:   ✗ ${r.message.split("\n")[0]}`,
            );
          }
        }
      }

      removeWorktree(repoDir, worktreeInfo.path);
      worktreeInfo = null;

      if (divergences.length > 0) {
        console.error(`repro: ⚠ ${entry.id} — diverged`);
        diverged++;
      } else if (assertionsFailed) {
        console.error(`repro: ✗ ${entry.id} — assertion failed`);
        failed++;
      } else {
        console.error(`repro: ✓ ${entry.id} — ${entry.title}`);
        passed++;
      }
    } catch (err) {
      if (worktreeInfo) {
        removeWorktree(repoDir, worktreeInfo.path);
      }
      console.error(
        `repro: ✗ ${entry.id} — error: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }
  }

  console.error(
    `\nrepro: ✓ ${passed} passed, ✗ ${failed} failed, ⚠ ${diverged} diverged`,
  );
  process.exit(failed > 0 || diverged > 0 ? 1 : 0);
}

function listCommand(_args: string[] = []): void {
  interface ListEntry {
    id: string;
    date: string;
    events: number;
    command: string;
    model?: string;
    auth?: string;
    source: "repo" | "daemon";
  }

  const entries: ListEntry[] = [];

  const reproPath = join(process.cwd(), ".repro");
  if (existsSync(reproPath)) {
    for (const d of readdirSync(reproPath, { withFileTypes: true })) {
      if (!d.isDirectory() || !d.name.startsWith("r-")) continue;
      const dir = join(reproPath, d.name);
      const metaPath = join(dir, "meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        entries.push({
          id: d.name,
          date: meta.startTime,
          events: meta.eventCount,
          command: meta.command?.join(" ") ?? "unknown",
          model: meta.model,
          auth: meta.auth,
          source: "repo",
        });
      } catch {
        // skip malformed meta
      }
    }
  }

  const tracesDir = getTracesDir();
  const daemonTraces = listDaemonTraces(tracesDir);
  for (const dt of daemonTraces) {
    if (entries.some((e) => e.id === dt.id)) continue;
    entries.push({
      id: dt.id,
      date: dt.meta.startTime,
      events: dt.meta.eventCount,
      command: dt.meta.command?.join(" ") ?? "daemon",
      model: dt.meta.model,
      source: "daemon",
    });
  }

  entries.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  const manifest = readManifest(process.cwd());
  const manifestMap = new Map(manifest.map((e) => [e.id, e]));

  if (entries.length === 0) {
    console.error("repro: no recordings found");
    return;
  }

  console.log("ID         Date                 Events  Status    Source   Command");
  console.log("─".repeat(90));

  for (const entry of entries) {
    const m = manifestMap.get(entry.id);
    const status = m ? m.status : "unsaved";
    const date = entry.date.slice(0, 19).replace("T", " ");
    console.log(
      `${entry.id.padEnd(10)} ${date.padEnd(20)} ${String(entry.events).padEnd(7)} ${status.padEnd(9)} ${entry.source.padEnd(8)} ${entry.command.slice(0, 30)}`,
    );
  }
}

function inspectCommand(args: string[]): void {
  const id = args.find((a) => !a.startsWith("--"));
  const jsonOutput = args.includes("--json");

  if (!id) {
    console.error("Usage: repro inspect <id> [--json]");
    process.exit(1);
  }

  const found = findTraceDir(id);
  if (!found) {
    console.error(`repro: trace ${id} not found`);
    process.exit(1);
  }
  const traceDir = found.dir;

  const reader = new TraceReader(traceDir);
  const meta = reader.readMeta();
  const events = reader.readEvents();

  if (jsonOutput) {
    console.log(JSON.stringify({ meta, events }, null, 2));
    return;
  }

  console.log(`Trace: ${meta.id}`);
  console.log(`Command: ${meta.command.join(" ")}`);
  if (meta.model) console.log(`Model: ${meta.model}`);
  if (meta.auth) console.log(`Auth: ${meta.auth}`);
  console.log(`Started: ${meta.startTime}`);
  console.log(`Events: ${meta.eventCount}`);
  console.log("");
  console.log("Timeline:");
  console.log("─".repeat(60));

  for (const event of events) {
    const prefix = `  [${String(event.seq).padStart(3)}]`;
    const ts = event.timestamp.slice(11, 23);

    switch (event.type) {
      case "process.start":
        console.log(
          `${prefix} ${ts} PROCESS START ${(event.data.command as string[])?.join(" ") ?? ""}`,
        );
        break;
      case "process.exit":
        console.log(
          `${prefix} ${ts} PROCESS EXIT  code=${event.data.code}`,
        );
        break;
      case "model.request":
        console.log(
          `${prefix} ${ts} MODEL REQUEST hash=${(event.data.normalizedHash as string)?.slice(0, 12)}…`,
        );
        break;
      case "model.response": {
        const body = event.data.body as Record<string, unknown> | undefined;
        const content = (body?.content as Array<Record<string, unknown>>) ?? [];
        const toolCalls = content.filter((c) => c.type === "tool_use");
        const textBlocks = content.filter((c) => c.type === "text");
        let summary = "";
        if (toolCalls.length > 0) {
          summary = toolCalls
            .map((t) => `tool:${t.name}`)
            .join(", ");
        } else if (textBlocks.length > 0) {
          const text = (textBlocks[0].text as string) ?? "";
          summary = text.slice(0, 50) + (text.length > 50 ? "…" : "");
        }
        console.log(
          `${prefix} ${ts} MODEL RESPONSE ${summary}`,
        );
        break;
      }
      default:
        console.log(
          `${prefix} ${ts} ${event.type.toUpperCase()}`,
        );
    }
  }
}

function diffCommand(args: string[]): void {
  const ids = args.filter((a) => !a.startsWith("--"));
  const jsonOutput = args.includes("--json");

  if (ids.length !== 2) {
    console.error("Usage: repro diff <a> <b> [--json]");
    process.exit(1);
  }

  const dirA = join(process.cwd(), ".repro", ids[0]);
  const dirB = join(process.cwd(), ".repro", ids[1]);

  if (!existsSync(dirA)) {
    console.error(`repro: trace ${ids[0]} not found`);
    process.exit(1);
  }
  if (!existsSync(dirB)) {
    console.error(`repro: trace ${ids[1]} not found`);
    process.exit(1);
  }

  const readerA = new TraceReader(dirA);
  const readerB = new TraceReader(dirB);
  const eventsA = readerA.readEvents();
  const eventsB = readerB.readEvents();

  const aligned = alignTraces(eventsA, eventsB);

  if (jsonOutput) {
    console.log(JSON.stringify(aligned, null, 2));
    return;
  }

  console.log(`Diff: ${ids[0]} ↔ ${ids[1]}`);
  console.log("─".repeat(60));

  for (const pair of aligned) {
    const seqA = pair.a ? String(pair.a.seq).padStart(3) : "   ";
    const seqB = pair.b ? String(pair.b.seq).padStart(3) : "   ";
    const typeA = pair.a?.type ?? "";
    const typeB = pair.b?.type ?? "";

    let marker: string;
    switch (pair.divergence) {
      case "match":
        marker = "  ";
        break;
      case "event_inserted":
        marker = "+ ";
        break;
      case "event_dropped":
        marker = "- ";
        break;
      default:
        marker = "~ ";
    }

    const label = pair.divergence === "match" ? "" : ` [${pair.divergence}]`;
    console.log(
      `${marker}[${seqA}|${seqB}] ${typeA || typeB}${label}`,
    );
  }

  const divergenceCount = aligned.filter((p) => p.divergence !== "match").length;
  console.log(`\n${divergenceCount} divergence(s) found.`);
}

function explainCommand(args: string[]): void {
  const ids = args.filter((a) => !a.startsWith("--"));

  if (ids.length !== 2) {
    console.error("Usage: repro explain <a> <b>");
    process.exit(1);
  }

  const dirA = join(process.cwd(), ".repro", ids[0]);
  const dirB = join(process.cwd(), ".repro", ids[1]);

  if (!existsSync(dirA) || !existsSync(dirB)) {
    console.error("repro: one or both traces not found");
    process.exit(1);
  }

  const readerA = new TraceReader(dirA);
  const readerB = new TraceReader(dirB);
  const eventsA = readerA.readEvents();
  const eventsB = readerB.readEvents();

  const aligned = alignTraces(eventsA, eventsB);
  const explanation = explainDivergence(aligned);

  console.log(explanation.summary);

  if (explanation.firstDivergence && !explanation.isEnvironmentDrift) {
    const pair = explanation.firstDivergence;
    console.log(`\nDivergence type: ${pair.divergence}`);
    if (pair.a) console.log(`Trace A seq: ${pair.a.seq} (${pair.a.type})`);
    if (pair.b) console.log(`Trace B seq: ${pair.b.seq} (${pair.b.type})`);
    if (explanation.downstreamCount > 0) {
      console.log(
        `${explanation.downstreamCount} downstream event(s) also diverged.`,
      );
    }
  }
}

async function minimizeCommand(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error(
      "Usage: repro minimize <id> --inputs context,files,tools --budget <n> [--k <n>] [--m <n>]",
    );
    process.exit(1);
  }

  const traceDir = join(process.cwd(), ".repro", id);
  if (!existsSync(traceDir)) {
    console.error(`repro: trace ${id} not found`);
    process.exit(1);
  }

  const budgetIdx = args.indexOf("--budget");
  if (budgetIdx === -1 || !args[budgetIdx + 1]) {
    console.error("repro: --budget <n> is required");
    process.exit(1);
  }
  const budget = parseFloat(args[budgetIdx + 1]);

  const kIdx = args.indexOf("--k");
  const k = kIdx >= 0 && args[kIdx + 1] ? parseInt(args[kIdx + 1]) : 3;

  const mIdx = args.indexOf("--m");
  const m = mIdx >= 0 && args[mIdx + 1] ? parseInt(args[mIdx + 1]) : 2;

  const inputsIdx = args.indexOf("--inputs");
  const inputTypes = inputsIdx >= 0 && args[inputsIdx + 1]
    ? args[inputsIdx + 1].split(",")
    : ["context", "files", "tools"];

  const reader = new TraceReader(traceDir);
  const events = reader.readEvents();

  const items: Array<{ type: string; index: number; value: unknown }> = [];
  const requestEvents = events.filter((e) => e.type === "model.request");

  if (requestEvents.length > 0) {
    const firstReq = reader.resolveEventData(requestEvents[0]);
    const body = firstReq.body as Record<string, unknown> | undefined;

    if (body && inputTypes.includes("tools") && Array.isArray(body.tools)) {
      for (let i = 0; i < body.tools.length; i++) {
        items.push({ type: "tool", index: i, value: body.tools[i] });
      }
    }

    if (body && inputTypes.includes("context") && Array.isArray(body.messages)) {
      const msgs = body.messages as Array<Record<string, unknown>>;
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role === "user") {
          items.push({ type: "context", index: i, value: msgs[i] });
        }
      }
    }

    if (body && inputTypes.includes("files")) {
      const msgs = body.messages as Array<Record<string, unknown>>;
      for (const msg of msgs) {
        if (msg.role === "user" && Array.isArray(msg.content)) {
          for (const block of msg.content as Array<Record<string, unknown>>) {
            if (block.type === "tool_result" && typeof block.content === "string") {
              items.push({ type: "file", index: items.length, value: block });
            }
          }
        }
      }
    }
  }

  if (items.length === 0) {
    console.error("repro: no minimizable inputs found in trace");
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  if (!apiKey || apiKey === "sk-repro-dummy" || apiKey.startsWith("sk-repro-")) {
    console.error("repro: minimize requires a real API key (set ANTHROPIC_API_KEY)");
    process.exit(1);
  }

  const assertionPath = join(traceDir, "assertions.json");
  const assertions: AssertionDef[] = existsSync(assertionPath)
    ? JSON.parse(readFileSync(assertionPath, "utf-8"))
    : [];

  if (assertions.length === 0) {
    console.error("repro: no assertions found — minimize needs assertions to detect failure reproduction");
    process.exit(1);
  }

  const firstReqData = reader.resolveEventData(requestEvents[0]);
  const originalRequest = firstReqData.body as AnthropicRequest;
  const costPerCall = estimateCostPerCall(originalRequest.model);

  console.error(`repro: minimizing ${items.length} inputs (budget: $${budget})`);
  console.error(`repro: oracle config: k=${k}, m=${m}, model=${originalRequest.model}`);
  console.error(`repro: estimated cost per oracle call: $${(costPerCall * k).toFixed(4)}`);

  const { oracle } = createLiveOracle({
    baseUrl,
    apiKey,
    originalRequest,
    assertions,
    workDir: process.cwd(),
  });

  const result = await minimize(items, oracle, {
    k,
    m,
    budgetDollars: budget,
    costPerCall,
  });

  console.error(`\nrepro: minimize result:`);
  console.error(`  original inputs:  ${result.originalCount}`);
  console.error(`  minimal inputs:   ${result.minimalCount}`);
  console.error(`  reproduction rate: ${(result.reproductionRate * 100).toFixed(0)}%`);
  console.error(`  oracle calls:     ${result.totalCalls}`);
  console.error(`  spend:            $${result.spend.toFixed(2)}`);
  if (result.budgetExhausted) {
    console.error(`  ⚠ budget exhausted — result may not be minimal`);
  }
}

function verifyCommand(args: string[]): void {
  const id = args.find((a) => !a.startsWith("--"));
  const jsonOutput = args.includes("--json");

  if (!id) {
    console.error("Usage: repro verify <id> [--json]");
    process.exit(1);
  }

  const found = findTraceDir(id);
  if (!found) {
    console.error(`repro: trace ${id} not found`);
    process.exit(1);
  }

  const result = verify(id, found.dir, process.cwd());

  if (jsonOutput) {
    console.log(formatVerifyJson(result));
  } else {
    console.log(formatVerifyResult(result));
  }

  process.exit(result.canReplay ? 0 : 1);
}

async function daemonCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "start":
      await startDaemon();
      break;
    case "stop":
      await stopDaemon();
      break;
    case "status":
      daemonStatus();
      break;
    default:
      console.error("Usage: repro daemon <start|stop|status>");
      process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "record":
      await recordCommand(args.slice(1));
      break;
    case "run":
      await runCommand(args.slice(1));
      break;
    case "init":
      initCommand();
      break;
    case "save":
      saveCommand(args.slice(1));
      break;
    case "test":
      await testCommand();
      break;
    case "list":
      listCommand(args.slice(1));
      break;
    case "inspect":
      inspectCommand(args.slice(1));
      break;
    case "diff":
      diffCommand(args.slice(1));
      break;
    case "explain":
      explainCommand(args.slice(1));
      break;
    case "minimize":
      await minimizeCommand(args.slice(1));
      break;
    case "verify":
      verifyCommand(args.slice(1));
      break;
    case "daemon":
      await daemonCommand(args.slice(1));
      break;
    case "_daemon-run":
      await daemonRun(args.slice(1));
      break;
    default:
      console.error("Usage: repro <command>");
      console.error("Commands:");
      console.error("  init               Initialize repro in current repo");
      console.error("  record [--model <name>] [--auth plan|credits] -- <cmd>");
      console.error("  run <id>           Replay a recorded run");
      console.error("  save <id>          Save a recording to REPRO.md");
      console.error("  test               Replay all open failures");
      console.error("  list               List all recordings");
      console.error("  inspect <id>       Show trace details");
      console.error("  diff <a> <b>       Compare two traces");
      console.error("  explain <a> <b>    Explain first divergence");
      console.error("  minimize <id>      Minimize reproducing inputs");
      console.error("  verify <id>        Verify replayability of a recording");
      console.error("  daemon start       Start background recording daemon");
      console.error("  daemon stop        Stop the daemon");
      console.error("  daemon status      Show daemon status");
      process.exit(1);
  }
}

const isDirectRun = process.argv[1]?.endsWith("/cli.js") ||
  process.argv[1]?.endsWith("/cli.ts") ||
  process.argv[1]?.endsWith("/repro");

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
