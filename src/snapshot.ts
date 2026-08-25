import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { platform, arch, release } from "node:os";

export const SNAPSHOT_FORMAT_VERSION = "1.0.0";

export interface EnvironmentSnapshot {
  formatVersion: string;
  timestamp: string;

  repository: {
    root: string;
    commit: string | null;
    branch: string | null;
    dirty: boolean;
    dirtyFileCount: number;
    dirtyDiff: string | null;
    untrackedFiles: string[];
  };

  platform: {
    os: string;
    arch: string;
    release: string;
  };

  runtimes: Record<string, string>;

  packageManager: {
    name: string | null;
    version: string | null;
  };

  lockfileHashes: Record<string, string>;

  agent: {
    name: string | null;
    version: string | null;
    model: string | null;
  };

  workdir: {
    absolute: string;
    relativeToRepo: string | null;
  };

  envVarNames: string[];
}

export interface SnapshotOptions {
  cwd?: string;
  agentName?: string;
  agentVersion?: string;
  model?: string;
}

const SAFE_UNTRACKED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".yaml", ".yml", ".toml",
  ".md", ".txt", ".csv",
  ".html", ".css", ".scss", ".less",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".sh", ".bash", ".zsh",
  ".sql", ".graphql",
  ".xml", ".svg",
  ".gitignore", ".eslintrc", ".prettierrc",
]);

const UNSAFE_UNTRACKED_PATTERNS = [
  ".env", ".pem", ".key", ".p12", ".pfx",
  "secret", "credential", "password", "token",
  "id_rsa", "id_ed25519", "id_dsa",
];

const SECRET_ENV_PREFIXES = [
  "SECRET", "PASSWORD", "TOKEN", "KEY", "CREDENTIAL",
  "AUTH", "PRIVATE",
];

const SAFE_ENV_PREFIXES = [
  "NODE", "NPM", "PYTHON", "PIP", "VIRTUAL_ENV",
  "GOPATH", "GOROOT", "CARGO", "RUSTUP",
  "JAVA", "MAVEN", "GRADLE",
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG",
  "EDITOR", "VISUAL", "PAGER",
  "XDG", "DISPLAY", "COLORTERM",
  "GIT", "SSH_AUTH_SOCK",
  "CI", "GITHUB", "GITLAB", "JENKINS", "CIRCLECI",
  "REPRO",
  "DEBUG", "VERBOSE", "LOG_LEVEL",
  "TZ", "LC_",
];

function execSafe(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function getGitRoot(cwd: string): string | null {
  return execSafe("git rev-parse --show-toplevel", cwd);
}

function getGitCommit(cwd: string): string | null {
  return execSafe("git rev-parse HEAD", cwd);
}

function getGitBranch(cwd: string): string | null {
  return execSafe("git rev-parse --abbrev-ref HEAD", cwd);
}

function isGitDirty(cwd: string): boolean {
  const status = execSafe("git status --porcelain", cwd);
  return status !== null && status.length > 0;
}

function getDirtyFileCount(cwd: string): number {
  const status = execSafe("git status --porcelain", cwd);
  if (!status) return 0;
  return status.split("\n").filter((l) => l.length > 0).length;
}

function getDirtyDiff(cwd: string): string | null {
  const diff = execSafe("git diff HEAD --stat", cwd);
  return diff && diff.length > 0 ? diff : null;
}

function getUntrackedFiles(cwd: string): string[] {
  const output = execSafe(
    "git ls-files --others --exclude-standard",
    cwd,
  );
  if (!output) return [];

  return output
    .split("\n")
    .filter((f) => f.length > 0)
    .filter((f) => isSafeUntrackedFile(f));
}

function isSafeUntrackedFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();

  for (const pattern of UNSAFE_UNTRACKED_PATTERNS) {
    if (lower.includes(pattern)) return false;
  }

  const ext = "." + filePath.split(".").pop()!;
  if (SAFE_UNTRACKED_EXTENSIONS.has(ext)) return true;

  const basename = filePath.split("/").pop() ?? filePath;
  if (SAFE_UNTRACKED_EXTENSIONS.has("." + basename)) return true;

  return false;
}

function getRuntimeVersion(cmd: string, cwd: string): string | null {
  return execSafe(`${cmd} --version`, cwd);
}

function detectRuntimes(cwd: string): Record<string, string> {
  const runtimes: Record<string, string> = {};

  const nodeVersion = getRuntimeVersion("node", cwd);
  if (nodeVersion) {
    runtimes.node = nodeVersion.replace(/^v/, "");
  }

  const npmVersion = getRuntimeVersion("npm", cwd);
  if (npmVersion) runtimes.npm = npmVersion;

  const pythonVersion =
    getRuntimeVersion("python3", cwd) ??
    getRuntimeVersion("python", cwd);
  if (pythonVersion) {
    const match = pythonVersion.match(/(\d+\.\d+\.\d+)/);
    if (match) runtimes.python = match[1];
  }

  const goVersion = getRuntimeVersion("go", cwd);
  if (goVersion) {
    const match = goVersion.match(/go(\d+\.\d+(?:\.\d+)?)/);
    if (match) runtimes.go = match[1];
  }

  const rustVersion = getRuntimeVersion("rustc", cwd);
  if (rustVersion) {
    const match = rustVersion.match(/(\d+\.\d+\.\d+)/);
    if (match) runtimes.rust = match[1];
  }

  return runtimes;
}

function detectPackageManager(cwd: string): { name: string | null; version: string | null } {
  const gitRoot = getGitRoot(cwd) ?? cwd;

  if (existsSync(join(gitRoot, "package-lock.json"))) {
    const version = getRuntimeVersion("npm", cwd);
    return { name: "npm", version };
  }
  if (existsSync(join(gitRoot, "yarn.lock"))) {
    const version = getRuntimeVersion("yarn", cwd);
    return { name: "yarn", version };
  }
  if (existsSync(join(gitRoot, "pnpm-lock.yaml"))) {
    const version = getRuntimeVersion("pnpm", cwd);
    return { name: "pnpm", version };
  }
  if (existsSync(join(gitRoot, "bun.lockb")) || existsSync(join(gitRoot, "bun.lock"))) {
    const version = getRuntimeVersion("bun", cwd);
    return { name: "bun", version };
  }
  if (existsSync(join(gitRoot, "Pipfile.lock"))) {
    const version = getRuntimeVersion("pipenv", cwd);
    return { name: "pipenv", version };
  }
  if (existsSync(join(gitRoot, "poetry.lock"))) {
    const version = getRuntimeVersion("poetry", cwd);
    return { name: "poetry", version };
  }
  if (existsSync(join(gitRoot, "Cargo.lock"))) {
    const version = getRuntimeVersion("cargo", cwd);
    return { name: "cargo", version };
  }
  if (existsSync(join(gitRoot, "go.sum"))) {
    const version = getRuntimeVersion("go", cwd);
    return { name: "go", version };
  }

  return { name: null, version: null };
}

function hashLockfiles(cwd: string): Record<string, string> {
  const gitRoot = getGitRoot(cwd) ?? cwd;
  const lockfiles: Record<string, string> = {};

  const candidates = [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "bun.lock",
    "Pipfile.lock",
    "poetry.lock",
    "Cargo.lock",
    "go.sum",
    "Gemfile.lock",
    "composer.lock",
  ];

  for (const name of candidates) {
    const path = join(gitRoot, name);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path);
        lockfiles[name] = "sha256:" + createHash("sha256").update(content).digest("hex");
      } catch {
        // skip unreadable files
      }
    }
  }

  return lockfiles;
}

function detectAgent(cwd: string, opts: SnapshotOptions): { name: string | null; version: string | null; model: string | null } {
  if (opts.agentName) {
    return {
      name: opts.agentName,
      version: opts.agentVersion ?? null,
      model: opts.model ?? null,
    };
  }

  const claudeVersion = execSafe("claude --version", cwd);
  if (claudeVersion) {
    return {
      name: "claude-code",
      version: claudeVersion.trim(),
      model: opts.model ?? null,
    };
  }

  const aiderVersion = execSafe("aider --version", cwd);
  if (aiderVersion) {
    const match = aiderVersion.match(/(\d+\.\d+\.\d+)/);
    return {
      name: "aider",
      version: match ? match[1] : aiderVersion.trim(),
      model: opts.model ?? null,
    };
  }

  return { name: null, version: null, model: opts.model ?? null };
}

function getFilteredEnvVarNames(): string[] {
  const names = Object.keys(process.env).sort();
  return names.filter((name) => {
    const upper = name.toUpperCase();

    for (const prefix of SECRET_ENV_PREFIXES) {
      if (upper.includes(prefix)) return false;
    }

    for (const prefix of SAFE_ENV_PREFIXES) {
      if (upper.startsWith(prefix)) return true;
    }

    if (upper === "PWD" || upper === "OLDPWD" || upper === "HOSTNAME") return true;

    return false;
  });
}

export function captureSnapshot(opts: SnapshotOptions = {}): EnvironmentSnapshot {
  const cwd = opts.cwd ?? process.cwd();
  const gitRoot = getGitRoot(cwd);

  const dirty = gitRoot ? isGitDirty(cwd) : false;

  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    timestamp: new Date().toISOString(),

    repository: {
      root: gitRoot ?? cwd,
      commit: gitRoot ? getGitCommit(cwd) : null,
      branch: gitRoot ? getGitBranch(cwd) : null,
      dirty,
      dirtyFileCount: dirty ? getDirtyFileCount(cwd) : 0,
      dirtyDiff: dirty ? getDirtyDiff(cwd) : null,
      untrackedFiles: gitRoot ? getUntrackedFiles(cwd) : [],
    },

    platform: {
      os: platform(),
      arch: arch(),
      release: release(),
    },

    runtimes: detectRuntimes(cwd),

    packageManager: detectPackageManager(cwd),

    lockfileHashes: hashLockfiles(cwd),

    agent: detectAgent(cwd, opts),

    workdir: {
      absolute: cwd,
      relativeToRepo: gitRoot ? relative(gitRoot, cwd) || "." : null,
    },

    envVarNames: getFilteredEnvVarNames(),
  };
}

export function formatSnapshot(snapshot: EnvironmentSnapshot): string {
  const lines: string[] = [];

  lines.push("Repository");
  if (snapshot.repository.commit) {
    lines.push(`  commit:   ${snapshot.repository.commit.slice(0, 7)}`);
  } else {
    lines.push("  commit:   (not a git repository)");
  }
  if (snapshot.repository.branch) {
    lines.push(`  branch:   ${snapshot.repository.branch}`);
  }
  lines.push(`  dirty:    ${snapshot.repository.dirty ? "yes" : "no"}`);
  if (snapshot.repository.dirty) {
    lines.push(`  changed:  ${snapshot.repository.dirtyFileCount} file(s)`);
  }
  if (snapshot.repository.untrackedFiles.length > 0) {
    lines.push(`  untracked: ${snapshot.repository.untrackedFiles.length} file(s)`);
  }

  lines.push("");
  lines.push("Environment");
  lines.push(`  platform: ${snapshot.platform.os}-${snapshot.platform.arch}`);

  for (const [name, version] of Object.entries(snapshot.runtimes)) {
    lines.push(`  ${name}: ${version}`);
  }

  if (snapshot.packageManager.name) {
    const ver = snapshot.packageManager.version
      ? ` ${snapshot.packageManager.version}`
      : "";
    lines.push(`  pkg-mgr:  ${snapshot.packageManager.name}${ver}`);
  }

  const lockfileEntries = Object.entries(snapshot.lockfileHashes);
  if (lockfileEntries.length > 0) {
    for (const [name, hash] of lockfileEntries) {
      lines.push(`  ${name}: ${hash.slice(0, 15)}...`);
    }
  }

  lines.push("");
  lines.push("Agent");
  if (snapshot.agent.name) {
    const ver = snapshot.agent.version ? ` ${snapshot.agent.version}` : "";
    lines.push(`  ${snapshot.agent.name}:${ver}`);
  } else {
    lines.push("  (not detected)");
  }
  if (snapshot.agent.model) {
    lines.push(`  model:    ${snapshot.agent.model}`);
  }

  lines.push("");
  lines.push("Workdir");
  if (snapshot.workdir.relativeToRepo !== null) {
    lines.push(`  relative: ${snapshot.workdir.relativeToRepo}`);
  } else {
    lines.push(`  path:     ${snapshot.workdir.absolute}`);
  }

  return lines.join("\n");
}

export function writeSnapshot(traceDir: string, snapshot: EnvironmentSnapshot): void {
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(
    join(traceDir, "snapshot.json"),
    JSON.stringify(snapshot, null, 2) + "\n",
    "utf-8",
  );
}

export function readSnapshot(traceDir: string): EnvironmentSnapshot | null {
  const snapshotPath = join(traceDir, "snapshot.json");
  if (!existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(readFileSync(snapshotPath, "utf-8"));
  } catch {
    return null;
  }
}
