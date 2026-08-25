import { execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TraceReader } from "./trace.js";
import type { TraceMeta } from "./types.js";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

export interface VerifyCheck {
  name: string;
  status: CheckStatus;
  message: string;
  category: "trace" | "environment" | "runtime" | "replay";
}

export interface VerifyResult {
  id: string;
  checks: VerifyCheck[];
  verdict: "REPLAYABLE" | "REPLAYABLE_WITH_WARNINGS" | "NOT_REPLAYABLE";
  canReplay: boolean;
  environmentIdentical: boolean;
  trustworthy: boolean;
}

export interface VerifyOptions {
  repoDir: string;
  traceDir: string;
  meta: TraceMeta;
  reader: TraceReader;
}

function check(
  name: string,
  status: CheckStatus,
  message: string,
  category: VerifyCheck["category"],
): VerifyCheck {
  return { name, status, message, category };
}

function sha256File(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function gitExec(cwd: string, cmd: string): string | null {
  try {
    return execSync(`git ${cmd}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function detectRuntime(): { name: string; version: string } | null {
  const version = process.version;
  if (version) {
    return { name: "node", version: version.replace(/^v/, "") };
  }
  return null;
}

function parseMajorMinor(v: string): { major: number; minor: number } {
  const parts = v.replace(/^v/, "").split(".");
  return {
    major: parseInt(parts[0]) || 0,
    minor: parseInt(parts[1]) || 0,
  };
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function getCommandVersion(cmd: string): string | null {
  try {
    return execSync(`${cmd} --version`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export function verifyTraceIntegrity(opts: VerifyOptions): VerifyCheck {
  const tracePath = join(opts.traceDir, "trace.json");
  if (!existsSync(tracePath)) {
    return check("trace integrity", "FAIL", "trace.json not found", "trace");
  }

  try {
    const content = readFileSync(tracePath, "utf-8");
    const events = JSON.parse(content);
    if (!Array.isArray(events)) {
      return check("trace integrity", "FAIL", "trace.json is not an array", "trace");
    }
    if (events.length === 0) {
      return check("trace integrity", "WARN", "trace.json is empty", "trace");
    }
    for (const event of events) {
      if (typeof event.seq !== "number" || typeof event.type !== "string") {
        return check("trace integrity", "FAIL", "malformed event in trace", "trace");
      }
    }
    return check("trace integrity", "PASS", `${events.length} events valid`, "trace");
  } catch (err) {
    return check("trace integrity", "FAIL", `corrupt trace: ${(err as Error).message}`, "trace");
  }
}

export function verifyMetaIntegrity(opts: VerifyOptions): VerifyCheck {
  const metaPath = join(opts.traceDir, "meta.json");
  if (!existsSync(metaPath)) {
    return check("metadata integrity", "FAIL", "meta.json not found", "trace");
  }

  try {
    const meta = opts.meta;
    if (!meta.id || !meta.command || !Array.isArray(meta.command)) {
      return check("metadata integrity", "FAIL", "meta.json missing required fields", "trace");
    }
    if (typeof meta.eventCount !== "number") {
      return check("metadata integrity", "WARN", "meta.json missing eventCount", "trace");
    }
    return check("metadata integrity", "PASS", "meta.json valid", "trace");
  } catch (err) {
    return check("metadata integrity", "FAIL", `corrupt meta: ${(err as Error).message}`, "trace");
  }
}

export function verifyRequiredBlobs(opts: VerifyOptions): VerifyCheck {
  const blobDir = join(opts.traceDir, "blobs");
  if (!existsSync(blobDir)) {
    return check("required blobs", "PASS", "no blob directory (inline data only)", "trace");
  }

  try {
    const events = opts.reader.readEvents();
    let missingCount = 0;
    const missingRefs: string[] = [];

    for (const event of events) {
      for (const value of Object.values(event.data)) {
        if (typeof value === "string" && value.startsWith("blob:sha256-")) {
          const hash = value.slice("blob:sha256-".length);
          const blobPath = join(blobDir, hash);
          if (!existsSync(blobPath)) {
            missingCount++;
            if (missingRefs.length < 3) {
              missingRefs.push(hash.slice(0, 12));
            }
          }
        }
      }
    }

    if (missingCount > 0) {
      return check(
        "required blobs",
        "FAIL",
        `${missingCount} blob(s) missing: ${missingRefs.join(", ")}…`,
        "trace",
      );
    }

    const blobCount = readdirSync(blobDir).length;
    return check("required blobs", "PASS", `${blobCount} blob(s) present`, "trace");
  } catch (err) {
    return check("required blobs", "FAIL", `blob check failed: ${(err as Error).message}`, "trace");
  }
}

export function verifyGitCommit(opts: VerifyOptions): VerifyCheck {
  if (!opts.meta.commit) {
    return check("git commit", "UNKNOWN", "no commit recorded in meta", "environment");
  }

  const result = gitExec(opts.repoDir, `cat-file -t ${opts.meta.commit}`);
  if (result === "commit") {
    return check("git commit available", "PASS", opts.meta.commit.slice(0, 10), "environment");
  }

  return check(
    "git commit available",
    "FAIL",
    `commit ${opts.meta.commit.slice(0, 10)} not found in repository`,
    "environment",
  );
}

export function verifyRepositoryState(opts: VerifyOptions): VerifyCheck {
  const status = gitExec(opts.repoDir, "status --porcelain");
  if (status === null) {
    return check("repository state", "UNKNOWN", "not a git repository", "environment");
  }

  const nonReproChanges = status
    .split("\n")
    .filter(l => l.trim() !== "" && !l.includes(".repro/"));

  if (nonReproChanges.length === 0) {
    return check("repository state", "PASS", "clean working tree", "environment");
  }

  const changedFiles = nonReproChanges.length;
  return check(
    "repository state",
    "WARN",
    `${changedFiles} uncommitted change(s) in working tree`,
    "environment",
  );
}

export function verifyPlatform(opts: VerifyOptions): VerifyCheck {
  if (!opts.meta.env) {
    return check("platform", "UNKNOWN", "no environment recorded", "environment");
  }

  const recordedPlatform = opts.meta.env.REPRO_PLATFORM;
  if (!recordedPlatform) {
    return check("platform", "UNKNOWN", "no platform recorded", "environment");
  }

  const currentPlatform = process.platform;
  if (recordedPlatform === currentPlatform) {
    return check("platform", "PASS", currentPlatform, "environment");
  }

  return check(
    "platform",
    "WARN",
    `recorded on ${recordedPlatform}, running on ${currentPlatform}`,
    "environment",
  );
}

export function verifyArchitecture(opts: VerifyOptions): VerifyCheck {
  if (!opts.meta.env) {
    return check("architecture", "UNKNOWN", "no environment recorded", "environment");
  }

  const recordedArch = opts.meta.env.REPRO_ARCH;
  if (!recordedArch) {
    return check("architecture", "UNKNOWN", "no architecture recorded", "environment");
  }

  const currentArch = process.arch;
  if (recordedArch === currentArch) {
    return check("architecture", "PASS", currentArch, "environment");
  }

  return check(
    "architecture",
    "WARN",
    `recorded on ${recordedArch}, running on ${currentArch}`,
    "environment",
  );
}

export function verifyRuntimeVersion(opts: VerifyOptions): VerifyCheck {
  const runtime = detectRuntime();
  if (!runtime) {
    return check("runtime version", "UNKNOWN", "could not detect runtime", "runtime");
  }

  if (!opts.meta.env) {
    return check(
      "runtime version",
      "UNKNOWN",
      `current: ${runtime.name} ${runtime.version} (no recorded version)`,
      "runtime",
    );
  }

  const recordedVersion = opts.meta.env.REPRO_NODE_VERSION;
  if (!recordedVersion) {
    return check(
      "runtime version",
      "UNKNOWN",
      `current: ${runtime.name} ${runtime.version} (no recorded version)`,
      "runtime",
    );
  }

  const recorded = parseMajorMinor(recordedVersion);
  const current = parseMajorMinor(runtime.version);

  if (recorded.major !== current.major) {
    return check(
      "runtime version",
      "FAIL",
      `Node ${recordedVersion} required, Node ${runtime.version} detected`,
      "runtime",
    );
  }

  if (recorded.minor !== current.minor) {
    return check(
      "runtime version",
      "WARN",
      `recorded on Node ${recordedVersion}, running Node ${runtime.version}`,
      "runtime",
    );
  }

  return check(
    "runtime version",
    "PASS",
    `Node ${runtime.version} compatible`,
    "runtime",
  );
}

export function verifyPackageManager(opts: VerifyOptions): VerifyCheck {
  if (!opts.meta.env) {
    return check("package manager", "UNKNOWN", "no environment recorded", "runtime");
  }

  const recordedPM = opts.meta.env.REPRO_PACKAGE_MANAGER;
  if (!recordedPM) {
    return check("package manager", "UNKNOWN", "no package manager recorded", "runtime");
  }

  const lockfiles: Record<string, string> = {
    npm: "package-lock.json",
    yarn: "yarn.lock",
    pnpm: "pnpm-lock.yaml",
    bun: "bun.lockb",
  };

  const detectedPM = Object.entries(lockfiles).find(([, file]) =>
    existsSync(join(opts.repoDir, file)),
  )?.[0];

  if (!detectedPM) {
    return check(
      "package manager",
      "WARN",
      `recorded ${recordedPM}, no lockfile detected`,
      "runtime",
    );
  }

  if (recordedPM === detectedPM) {
    return check("package manager", "PASS", recordedPM, "runtime");
  }

  return check(
    "package manager",
    "WARN",
    `recorded ${recordedPM}, detected ${detectedPM}`,
    "runtime",
  );
}

export function verifyLockfileHash(opts: VerifyOptions): VerifyCheck {
  if (!opts.meta.env) {
    return check("lockfile hash", "UNKNOWN", "no environment recorded", "environment");
  }

  const recordedHash = opts.meta.env.REPRO_LOCKFILE_HASH;
  if (!recordedHash) {
    return check("lockfile hash", "UNKNOWN", "no lockfile hash recorded", "environment");
  }

  const lockfiles = [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
  ];

  for (const lf of lockfiles) {
    const path = join(opts.repoDir, lf);
    if (existsSync(path)) {
      const currentHash = sha256File(path);
      if (currentHash === recordedHash) {
        return check("lockfile hash", "PASS", `${lf} matches`, "environment");
      }
      return check(
        "lockfile hash",
        "WARN",
        `${lf} differs from recording`,
        "environment",
      );
    }
  }

  return check("lockfile hash", "WARN", "no lockfile found", "environment");
}

export function verifyRequiredFiles(opts: VerifyOptions): VerifyCheck {
  if (!opts.meta.env) {
    return check("required files", "UNKNOWN", "no environment recorded", "environment");
  }

  const requiredRaw = opts.meta.env.REPRO_REQUIRED_FILES;
  if (!requiredRaw) {
    return check("required files", "UNKNOWN", "no required files recorded", "environment");
  }

  const requiredFiles = requiredRaw.split(",").map(f => f.trim()).filter(Boolean);
  const missing: string[] = [];

  for (const f of requiredFiles) {
    if (!existsSync(join(opts.repoDir, f))) {
      missing.push(f);
    }
  }

  if (missing.length > 0) {
    return check(
      "required files",
      "FAIL",
      `missing: ${missing.join(", ")}`,
      "environment",
    );
  }

  return check("required files", "PASS", `${requiredFiles.length} file(s) present`, "environment");
}

export function verifyAgentBinary(opts: VerifyOptions): VerifyCheck {
  if (!opts.meta.command || opts.meta.command.length === 0) {
    return check("agent binary", "FAIL", "no command recorded", "replay");
  }

  const binary = opts.meta.command[0];

  if (binary === process.execPath || binary === "node" || binary.endsWith("/node")) {
    return check("agent binary", "PASS", binary, "replay");
  }

  if (existsSync(binary)) {
    return check("agent binary", "PASS", binary, "replay");
  }

  if (commandExists(binary)) {
    return check("agent binary", "PASS", `${binary} found on PATH`, "replay");
  }

  return check(
    "agent binary",
    "FAIL",
    `'${binary}' not found on PATH`,
    "replay",
  );
}

export function verifyAgentVersion(opts: VerifyOptions): VerifyCheck {
  if (!opts.meta.env) {
    return check("agent version", "UNKNOWN", "no environment recorded", "replay");
  }

  const recordedVersion = opts.meta.env.REPRO_AGENT_VERSION;
  if (!recordedVersion) {
    return check("agent version", "UNKNOWN", "no agent version recorded", "replay");
  }

  if (!opts.meta.command || opts.meta.command.length === 0) {
    return check("agent version", "UNKNOWN", "no command recorded", "replay");
  }

  const binary = opts.meta.command[0];
  const currentVersion = getCommandVersion(binary);

  if (!currentVersion) {
    return check(
      "agent version",
      "UNKNOWN",
      `recorded ${recordedVersion}, could not detect current version`,
      "replay",
    );
  }

  const versionMatch = currentVersion.match(/(\d+\.\d+\.\d+)/);
  const cleanVersion = versionMatch ? versionMatch[1] : currentVersion;

  if (cleanVersion === recordedVersion) {
    return check("agent version", "PASS", recordedVersion, "replay");
  }

  return check(
    "agent version",
    "WARN",
    `recorded ${recordedVersion}, current ${cleanVersion}`,
    "replay",
  );
}

export function verifyModelCompatibility(opts: VerifyOptions): VerifyCheck {
  try {
    const events = opts.reader.readEvents();
    const responseEvents = events.filter(e => e.type === "model.response");

    if (responseEvents.length === 0) {
      return check("model responses", "WARN", "no model responses in trace", "replay");
    }

    return check(
      "model responses recorded",
      "PASS",
      `${responseEvents.length} response(s) available for replay`,
      "replay",
    );
  } catch {
    return check("model responses recorded", "FAIL", "could not read trace events", "replay");
  }
}

export function verifyReplayPrerequisites(opts: VerifyOptions): VerifyCheck {
  const events = opts.reader.readEvents();
  const requestEvents = events.filter(e => e.type === "model.request");
  const responseEvents = events.filter(e => e.type === "model.response");

  if (requestEvents.length === 0 && responseEvents.length === 0) {
    return check(
      "replay prerequisites",
      "WARN",
      "no API exchanges recorded — replay will be a no-op",
      "replay",
    );
  }

  if (requestEvents.length !== responseEvents.length) {
    return check(
      "replay prerequisites",
      "WARN",
      `${requestEvents.length} request(s) but ${responseEvents.length} response(s) — incomplete exchange`,
      "replay",
    );
  }

  return check(
    "replay prerequisites",
    "PASS",
    `${requestEvents.length} complete exchange(s)`,
    "replay",
  );
}

export function verifyWorktreePrerequisites(opts: VerifyOptions): VerifyCheck {
  const inGitRepo = gitExec(opts.repoDir, "rev-parse --git-dir") !== null;
  if (!inGitRepo) {
    return check(
      "worktree support",
      "WARN",
      "not a git repository — worktree isolation unavailable",
      "replay",
    );
  }

  if (!opts.meta.commit) {
    return check(
      "worktree support",
      "WARN",
      "no commit recorded — worktree will use HEAD",
      "replay",
    );
  }

  const commitAvailable = gitExec(opts.repoDir, `cat-file -t ${opts.meta.commit}`);
  if (commitAvailable !== "commit") {
    return check(
      "worktree support",
      "FAIL",
      `cannot create worktree: commit ${opts.meta.commit.slice(0, 10)} not found`,
      "replay",
    );
  }

  return check("worktree support", "PASS", "git worktree available", "replay");
}

export function runAllChecks(opts: VerifyOptions): VerifyCheck[] {
  return [
    verifyTraceIntegrity(opts),
    verifyMetaIntegrity(opts),
    verifyRequiredBlobs(opts),
    verifyGitCommit(opts),
    verifyRepositoryState(opts),
    verifyPlatform(opts),
    verifyArchitecture(opts),
    verifyRuntimeVersion(opts),
    verifyPackageManager(opts),
    verifyLockfileHash(opts),
    verifyRequiredFiles(opts),
    verifyAgentBinary(opts),
    verifyAgentVersion(opts),
    verifyModelCompatibility(opts),
    verifyReplayPrerequisites(opts),
    verifyWorktreePrerequisites(opts),
  ];
}

export function computeVerdict(checks: VerifyCheck[]): VerifyResult["verdict"] {
  const hasFail = checks.some(c => c.status === "FAIL");
  const hasWarn = checks.some(c => c.status === "WARN");

  if (hasFail) return "NOT_REPLAYABLE";
  if (hasWarn) return "REPLAYABLE_WITH_WARNINGS";
  return "REPLAYABLE";
}

export function verify(
  id: string,
  traceDir: string,
  repoDir: string,
): VerifyResult {
  const reader = new TraceReader(traceDir);
  const meta = reader.readMeta();

  const opts: VerifyOptions = { repoDir, traceDir, meta, reader };
  const checks = runAllChecks(opts);
  const verdict = computeVerdict(checks);

  const hasFail = checks.some(c => c.status === "FAIL");
  const hasWarnOrUnknown = checks.some(c => c.status === "WARN" || c.status === "UNKNOWN");
  const environmentChecks = checks.filter(c => c.category === "environment");
  const envIdentical = environmentChecks.every(c => c.status === "PASS");

  return {
    id,
    checks,
    verdict,
    canReplay: !hasFail,
    environmentIdentical: envIdentical,
    trustworthy: !hasFail && !hasWarnOrUnknown,
  };
}

export function formatVerifyResult(result: VerifyResult): string {
  const lines: string[] = [];
  lines.push(`Reproduction: ${result.id}`);
  lines.push("");

  for (const c of result.checks) {
    const icon = c.status === "PASS" ? "✓" : c.status === "WARN" ? "⚠" : c.status === "FAIL" ? "✗" : "?";
    lines.push(`${icon} ${c.name}: ${c.message}`);
  }

  lines.push("");
  lines.push(`Result: ${result.verdict.replace(/_/g, " ")}`);

  return lines.join("\n");
}

export function formatVerifyJson(result: VerifyResult): string {
  return JSON.stringify(result, null, 2);
}
