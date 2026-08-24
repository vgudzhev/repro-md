import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { RecordingProxy } from "./proxy.js";
import { SessionSplitter } from "./session-splitter.js";
import {
  loadDaemonConfig,
  pruneTraces,
  getDaemonDiskUsage,
} from "./retention.js";
import { generateTraceId } from "./id.js";

export function getReproHome(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return join(home, ".repro");
}

export function getTracesDir(): string {
  return join(getReproHome(), "traces");
}

function getDaemonJsonPath(): string {
  return join(getReproHome(), "daemon.json");
}

interface DaemonInfo {
  pid: number;
  port: number;
  startTime: string;
}

function readDaemonInfo(): DaemonInfo | null {
  const path = getDaemonJsonPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeDaemonInfo(info: DaemonInfo): void {
  const dir = getReproHome();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    getDaemonJsonPath(),
    JSON.stringify(info, null, 2) + "\n",
    "utf-8",
  );
}

function removeDaemonInfo(): void {
  const path = getDaemonJsonPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startDaemon(): Promise<void> {
  const config = loadDaemonConfig();
  const info = readDaemonInfo();

  if (info && isProcessAlive(info.pid)) {
    console.error(
      `repro: daemon already running (pid ${info.pid}, port ${info.port})`,
    );
    process.exit(1);
  }

  if (info && !isProcessAlive(info.pid)) {
    removeDaemonInfo();
  }

  const port = config.port;
  const available = await isPortAvailable(port);
  if (!available) {
    console.error(`repro: port ${port} is already in use`);
    console.error(
      `repro: stop any process using port ${port} or change the port in ~/.repro/config.json`,
    );
    process.exit(1);
  }

  const reproHome = getReproHome();
  mkdirSync(reproHome, { recursive: true });

  const logPath = join(reproHome, "daemon.log");
  const logFd = openSync(logPath, "a");

  const cliPath = process.argv[1];
  const child = spawn(
    process.execPath,
    [cliPath, "_daemon-run", "--port", String(port)],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    },
  );

  child.unref();

  console.error(`repro: daemon running on 127.0.0.1:${port}`);
  console.error(`repro: add this to your shell profile:`);
  console.error(`  export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
  console.error(
    `repro: all Claude Code sessions will be recorded automatically`,
  );
}

export async function stopDaemon(): Promise<void> {
  const info = readDaemonInfo();

  if (!info) {
    console.error("repro: daemon is not running");
    process.exit(1);
  }

  if (!isProcessAlive(info.pid)) {
    removeDaemonInfo();
    console.error("repro: daemon was not running (cleaned up stale state)");
    return;
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch (err) {
    console.error(
      `repro: failed to stop daemon: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessAlive(info.pid)) {
    await sleep(100);
  }

  if (isProcessAlive(info.pid)) {
    console.error(
      "repro: daemon did not stop within 5 seconds, sending SIGKILL",
    );
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }

  removeDaemonInfo();
  console.error("repro: daemon stopped");
}

export function daemonStatus(): void {
  const info = readDaemonInfo();

  if (!info) {
    console.error("repro: daemon is not running");
    return;
  }

  if (!isProcessAlive(info.pid)) {
    removeDaemonInfo();
    console.error("repro: daemon is not running (cleaned up stale state)");
    return;
  }

  const tracesDir = getTracesDir();
  const { totalMb, traceCount } = getDaemonDiskUsage(tracesDir);

  const uptimeMs = Date.now() - new Date(info.startTime).getTime();
  const uptimeStr = formatUptime(uptimeMs);

  console.error(`repro: daemon running`);
  console.error(`  pid:     ${info.pid}`);
  console.error(`  port:    ${info.port}`);
  console.error(`  uptime:  ${uptimeStr}`);
  console.error(`  traces:  ${traceCount}`);
  console.error(`  disk:    ${totalMb} MB`);
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export async function daemonRun(args: string[]): Promise<void> {
  const portIdx = args.indexOf("--port");
  const port =
    portIdx >= 0 && args[portIdx + 1]
      ? parseInt(args[portIdx + 1])
      : 7717;

  const config = loadDaemonConfig();
  const tracesDir = getTracesDir();
  mkdirSync(tracesDir, { recursive: true });

  const upstream =
    process.env.REPRO_UPSTREAM ?? "https://api.anthropic.com";

  const firstTraceId = generateTraceId();
  const firstTraceDir = join(tracesDir, firstTraceId);

  let exchangeHandler: (() => void) | null = null;

  const proxy = new RecordingProxy({
    upstream,
    traceDir: firstTraceDir,
    traceId: firstTraceId,
    onExchangeComplete: () => exchangeHandler?.(),
  });

  const splitter = new SessionSplitter({
    idleSplitMs: config.idle_split_seconds * 1000,
    tracesDir,
    initialId: firstTraceId,
    initialDir: firstTraceDir,
    getEventCount: () => proxy.getTraceWriter().getEventCount(),
    finalizeTrace: () => proxy.getTraceWriter().finalize(),
    writeMeta: (meta) => proxy.getTraceWriter().writeMeta(meta),
    resetTrace: (dir) => proxy.resetTrace(dir),
  });

  exchangeHandler = () => splitter.onExchangeComplete();

  try {
    await proxy.start(port);
  } catch (err) {
    console.error(
      `repro: daemon failed to start on port ${port}: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  const daemonInfo: DaemonInfo = {
    pid: process.pid,
    port,
    startTime: new Date().toISOString(),
  };
  writeDaemonInfo(daemonInfo);

  console.error(`repro: daemon listening on 127.0.0.1:${port}`);

  const savedIds = new Set<string>();
  const pruned = pruneTraces(tracesDir, config, savedIds);
  if (pruned > 0) {
    console.error(`repro: pruned ${pruned} old trace(s)`);
  }

  const pruneInterval = setInterval(() => {
    pruneTraces(tracesDir, config, new Set<string>());
  }, 60 * 60 * 1000);
  pruneInterval.unref();

  const shutdown = async () => {
    console.error("repro: daemon shutting down...");

    clearInterval(pruneInterval);
    splitter.finalizeCurrentSession();
    splitter.destroy();

    await sleep(1000);
    await proxy.stop();
    removeDaemonInfo();

    console.error("repro: daemon stopped");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
