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
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  exportBundle,
  importBundle,
  readBundle,
  validateBundle,
  checkBundleSecurity,
  stableStringify,
  BUNDLE_FORMAT_VERSION,
} from "../src/bundle.js";
import type { Bundle } from "../src/bundle.js";
import type { TraceMeta, TraceEvent, AssertionDef } from "../src/types.js";
import { RecordingProxy, ReplayProxy } from "../src/proxy.js";
import { StubUpstream } from "../src/test-fixtures/stub-upstream.js";
import { TraceReader } from "../src/trace.js";
import { evaluateAssertions } from "../src/assertions.js";
import { createWorktree, removeWorktree } from "../src/worktree.js";
import { computeBlobHash } from "../src/blob.js";

const TEST_BASE = join(
  import.meta.dirname,
  "..",
  ".test-bundle-" + process.pid,
);

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
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

function createMinimalTrace(traceDir: string, opts: {
  id?: string;
  events?: TraceEvent[];
  assertions?: AssertionDef[];
  blobs?: Record<string, string>;
  meta?: Partial<TraceMeta>;
} = {}): void {
  mkdirSync(traceDir, { recursive: true });

  const id = opts.id ?? "r-test01";
  const meta: TraceMeta = {
    id,
    command: ["node", "agent.js"],
    startTime: "2026-08-25T10:00:00.000Z",
    endTime: "2026-08-25T10:01:00.000Z",
    eventCount: opts.events?.length ?? 2,
    commit: "abc123",
    cwd: "/home/user/project",
    ...opts.meta,
  };
  writeFileSync(join(traceDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");

  const events: TraceEvent[] = opts.events ?? [
    { seq: 0, type: "process.start", timestamp: "2026-08-25T10:00:00.000Z", data: { command: ["node", "agent.js"] } },
    { seq: 1, type: "process.exit", timestamp: "2026-08-25T10:01:00.000Z", data: { code: 0 } },
  ];
  writeFileSync(join(traceDir, "trace.json"), JSON.stringify(events, null, 2) + "\n", "utf-8");

  if (opts.assertions) {
    writeFileSync(join(traceDir, "assertions.json"), JSON.stringify(opts.assertions, null, 2) + "\n", "utf-8");
  }

  if (opts.blobs) {
    const blobDir = join(traceDir, "blobs");
    mkdirSync(blobDir, { recursive: true });
    for (const [hash, content] of Object.entries(opts.blobs)) {
      writeFileSync(join(blobDir, hash), content, "utf-8");
    }
  }
}

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_BASE, { recursive: true, force: true });
});

describe("export/import round trip", () => {
  it("exports and imports a minimal trace", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-round1");
    createMinimalTrace(traceDir, { id: "r-round1" });

    const bundlePath = join(TEST_BASE, "repro-r-round1.repro");
    const result = exportBundle(traceDir, bundlePath, "0.1.2");

    expect(result.id).toBe("r-round1");
    expect(result.checksum).toBeTruthy();
    expect(existsSync(bundlePath)).toBe(true);

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });
    const imported = importBundle(bundlePath, importDir);

    expect(imported.id).toBe("r-round1");
    expect(imported.idChanged).toBe(false);

    const importedMeta: TraceMeta = JSON.parse(
      readFileSync(join(imported.traceDir, "meta.json"), "utf-8"),
    );
    expect(importedMeta.id).toBe("r-round1");
    expect(importedMeta.command).toEqual(["node", "agent.js"]);
    expect(importedMeta.cwd).toBeUndefined();

    const importedEvents: TraceEvent[] = JSON.parse(
      readFileSync(join(imported.traceDir, "trace.json"), "utf-8"),
    );
    expect(importedEvents).toHaveLength(2);
  });

  it("round-trips assertions", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-assert1");
    const assertions: AssertionDef[] = [
      { type: "max_calls", args: { max: 5 } },
      { type: "forbidden_path", args: { pattern: "src/gen/**" } },
    ];
    createMinimalTrace(traceDir, { id: "r-assert1", assertions });

    const bundlePath = join(TEST_BASE, "assert.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });
    const imported = importBundle(bundlePath, importDir);

    const importedAssertions: AssertionDef[] = JSON.parse(
      readFileSync(join(imported.traceDir, "assertions.json"), "utf-8"),
    );
    expect(importedAssertions).toEqual(assertions);
  });

  it("round-trips blobs", () => {
    const blobContent = "x".repeat(20000);
    const blobHash = computeBlobHash(blobContent);
    const traceDir = join(TEST_BASE, ".repro", "r-blob1");

    const events: TraceEvent[] = [
      { seq: 0, type: "model.response", timestamp: "2026-08-25T10:00:00.000Z", data: { body: `blob:sha256-${blobHash}` } },
    ];
    createMinimalTrace(traceDir, {
      id: "r-blob1",
      events,
      blobs: { [blobHash]: blobContent },
      meta: { eventCount: 1 },
    });

    const bundlePath = join(TEST_BASE, "blob.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });
    const imported = importBundle(bundlePath, importDir);

    const importedBlob = readFileSync(
      join(imported.traceDir, "blobs", blobHash),
      "utf-8",
    );
    expect(importedBlob).toBe(blobContent);
  });

  it("sanitizes cwd from meta on export", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-cwd1");
    createMinimalTrace(traceDir, {
      id: "r-cwd1",
      meta: { cwd: "/home/user/secret-project" },
    });

    const bundlePath = join(TEST_BASE, "cwd.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const bundle = readBundle(bundlePath);
    expect(bundle.meta.cwd).toBeUndefined();
  });
});

describe("corrupted archive", () => {
  it("rejects non-gzip data", () => {
    const badPath = join(TEST_BASE, "bad.repro");
    writeFileSync(badPath, "not gzipped data", "utf-8");

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });

    expect(() => importBundle(badPath, importDir)).toThrow(/decompress/);
  });

  it("rejects gzipped non-JSON", () => {
    const badPath = join(TEST_BASE, "bad.repro");
    writeFileSync(badPath, gzipSync("not json {{{"));

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });

    expect(() => importBundle(badPath, importDir)).toThrow(/parse/);
  });

  it("rejects tampered checksum", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-tamper1");
    createMinimalTrace(traceDir, { id: "r-tamper1" });

    const bundlePath = join(TEST_BASE, "tamper.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const bundle = readBundle(bundlePath);
    bundle.checksum = "0000000000000000000000000000000000000000000000000000000000000000";
    const tampered = gzipSync(Buffer.from(stableStringify(bundle), "utf-8"), { level: 9 });
    writeFileSync(bundlePath, tampered);

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });

    expect(() => importBundle(bundlePath, importDir)).toThrow(/CHECKSUM_MISMATCH/);
  });
});

describe("corrupted blob", () => {
  it("rejects blob with mismatched content-address", () => {
    const blobContent = "original content";
    const blobHash = computeBlobHash(blobContent);
    const traceDir = join(TEST_BASE, ".repro", "r-badb1");

    createMinimalTrace(traceDir, {
      id: "r-badb1",
      events: [
        { seq: 0, type: "model.response", timestamp: "2026-08-25T10:00:00.000Z", data: { body: `blob:sha256-${blobHash}` } },
      ],
      blobs: { [blobHash]: blobContent },
      meta: { eventCount: 1 },
    });

    const bundlePath = join(TEST_BASE, "badb.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const bundle = readBundle(bundlePath);
    bundle.blobs[blobHash] = "tampered content";
    bundle.checksum = "";
    bundle.checksum = sha256(stableStringify(bundle));
    writeFileSync(bundlePath, gzipSync(Buffer.from(stableStringify(bundle), "utf-8"), { level: 9 }));

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });

    expect(() => importBundle(bundlePath, importDir)).toThrow(/INTEGRITY_BLOB|BLOB_HASH_MISMATCH/);
  });
});

describe("missing blob", () => {
  it("rejects bundle with referenced but absent blob", () => {
    const missingHash = sha256("missing blob content");

    const bundle: Bundle = {
      version: 1,
      generator: "repro-md",
      generatorVersion: "0.1.2",
      id: "r-miss1",
      created: "2026-08-25T10:00:00.000Z",
      checksum: "",
      meta: {
        id: "r-miss1",
        command: ["node"],
        startTime: "2026-08-25T10:00:00.000Z",
        eventCount: 1,
      },
      trace: [
        { seq: 0, type: "model.response", timestamp: "2026-08-25T10:00:00.000Z", data: { body: `blob:sha256-${missingHash}` } },
      ],
      assertions: null,
      blobs: {},
      integrity: {
        meta: sha256(stableStringify({ id: "r-miss1", command: ["node"], startTime: "2026-08-25T10:00:00.000Z", eventCount: 1 })),
        trace: sha256(stableStringify([{ seq: 0, type: "model.response", timestamp: "2026-08-25T10:00:00.000Z", data: { body: `blob:sha256-${missingHash}` } }])),
      },
    };
    bundle.checksum = sha256(stableStringify(bundle));

    const bundlePath = join(TEST_BASE, "miss.repro");
    writeFileSync(bundlePath, gzipSync(Buffer.from(stableStringify(bundle), "utf-8"), { level: 9 }));

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });

    expect(() => importBundle(bundlePath, importDir)).toThrow(/MISSING_BLOB/);
  });
});

describe("version mismatch", () => {
  it("rejects future version", () => {
    const bundle: Record<string, unknown> = {
      version: 999,
      generator: "repro-md",
      generatorVersion: "99.0.0",
      id: "r-future",
      created: "2026-08-25T10:00:00.000Z",
      checksum: "will-be-set",
      meta: { id: "r-future", command: ["node"], startTime: "2026-08-25T10:00:00.000Z", eventCount: 0 },
      trace: [],
      assertions: null,
      blobs: {},
      integrity: {},
    };
    bundle.checksum = "";
    bundle.checksum = sha256(stableStringify(bundle));

    const error = validateBundle(bundle);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("VERSION_MISMATCH");
  });

  it("rejects version 0", () => {
    const error = validateBundle({ version: 0 });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("VERSION_MISMATCH");
  });

  it("accepts current version", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-ver1");
    createMinimalTrace(traceDir, { id: "r-ver1" });

    const bundlePath = join(TEST_BASE, "ver.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const bundle = readBundle(bundlePath);
    expect(bundle.version).toBe(BUNDLE_FORMAT_VERSION);

    const error = validateBundle(bundle);
    expect(error).toBeNull();
  });
});

describe("ID collision", () => {
  it("generates new ID on collision", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-coll1");
    createMinimalTrace(traceDir, { id: "r-coll1" });

    const bundlePath = join(TEST_BASE, "coll.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(join(importDir, "r-coll1"), { recursive: true });
    writeFileSync(join(importDir, "r-coll1", "meta.json"), "{}", "utf-8");

    const imported = importBundle(bundlePath, importDir);
    expect(imported.idChanged).toBe(true);
    expect(imported.id).not.toBe("r-coll1");
    expect(imported.originalId).toBe("r-coll1");
    expect(imported.id).toMatch(/^r-[0-9a-f]{6}$/);
  });

  it("preserves ID when no collision", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-nocoll");
    createMinimalTrace(traceDir, { id: "r-nocoll" });

    const bundlePath = join(TEST_BASE, "nocoll.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });

    const imported = importBundle(bundlePath, importDir);
    expect(imported.idChanged).toBe(false);
    expect(imported.id).toBe("r-nocoll");
  });
});

describe("redaction / security", () => {
  it("detects API keys in trace content", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-sec1");
    const events: TraceEvent[] = [
      {
        seq: 0,
        type: "model.request",
        timestamp: "2026-08-25T10:00:00.000Z",
        data: { body: { content: "my key is sk-ant-api03-abcdefghijklmnopqrstuvwx" } },
      },
    ];
    createMinimalTrace(traceDir, { id: "r-sec1", events, meta: { eventCount: 1 } });

    const result = checkBundleSecurity(traceDir);
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.type === "secret")).toBe(true);
  });

  it("detects absolute paths", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-sec2");
    const events: TraceEvent[] = [
      {
        seq: 0,
        type: "model.request",
        timestamp: "2026-08-25T10:00:00.000Z",
        data: { body: { content: "reading file at /home/user/project/secret.txt" } },
      },
    ];
    createMinimalTrace(traceDir, { id: "r-sec2", events, meta: { eventCount: 1 } });

    const result = checkBundleSecurity(traceDir);
    expect(result.findings.some((f) => f.type === "absolute_path")).toBe(true);
  });

  it("reports redaction markers as low severity", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-sec3");
    const events: TraceEvent[] = [
      {
        seq: 0,
        type: "model.request",
        timestamp: "2026-08-25T10:00:00.000Z",
        data: { body: "value is [[redacted:env:MY_SECRET:abcd1234]]" },
      },
    ];
    createMinimalTrace(traceDir, { id: "r-sec3", events, meta: { eventCount: 1 } });

    const result = checkBundleSecurity(traceDir);
    const marker = result.findings.find((f) => f.type === "redacted_marker");
    expect(marker).toBeDefined();
    expect(marker!.severity).toBe("low");
  });

  it("reports safe when content is clean", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-sec4");
    createMinimalTrace(traceDir, { id: "r-sec4" });

    const result = checkBundleSecurity(traceDir);
    expect(result.safe).toBe(true);
    expect(result.findings.filter((f) => f.severity === "high")).toHaveLength(0);
  });
});

describe("absolute path sanitization", () => {
  it("removes cwd from exported meta", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-path1");
    createMinimalTrace(traceDir, {
      id: "r-path1",
      meta: { cwd: "/Users/alice/projects/myapp" },
    });

    const bundlePath = join(TEST_BASE, "path.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const bundle = readBundle(bundlePath);
    expect(bundle.meta.cwd).toBeUndefined();
    expect(JSON.stringify(bundle.meta)).not.toContain("/Users/alice");
  });
});

describe("large blobs", () => {
  it("handles 1MB blob", () => {
    const largeBlobContent = "A".repeat(1024 * 1024);
    const blobHash = computeBlobHash(largeBlobContent);
    const traceDir = join(TEST_BASE, ".repro", "r-large1");

    createMinimalTrace(traceDir, {
      id: "r-large1",
      events: [
        { seq: 0, type: "model.response", timestamp: "2026-08-25T10:00:00.000Z", data: { body: `blob:sha256-${blobHash}` } },
      ],
      blobs: { [blobHash]: largeBlobContent },
      meta: { eventCount: 1 },
    });

    const bundlePath = join(TEST_BASE, "large.repro");
    const result = exportBundle(traceDir, bundlePath, "0.1.2");
    expect(result.checksum).toBeTruthy();

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });
    const imported = importBundle(bundlePath, importDir);

    const importedBlob = readFileSync(join(imported.traceDir, "blobs", blobHash), "utf-8");
    expect(importedBlob).toBe(largeBlobContent);
  });
});

describe("empty traces", () => {
  it("exports and imports an empty trace", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-empty1");
    createMinimalTrace(traceDir, {
      id: "r-empty1",
      events: [],
      meta: { eventCount: 0 },
    });

    const bundlePath = join(TEST_BASE, "empty.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });
    const imported = importBundle(bundlePath, importDir);

    const events = JSON.parse(
      readFileSync(join(imported.traceDir, "trace.json"), "utf-8"),
    );
    expect(events).toEqual([]);
  });

  it("exports without assertions", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-noassert");
    createMinimalTrace(traceDir, { id: "r-noassert" });

    const bundlePath = join(TEST_BASE, "noassert.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const bundle = readBundle(bundlePath);
    expect(bundle.assertions).toBeNull();

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });
    const imported = importBundle(bundlePath, importDir);

    expect(existsSync(join(imported.traceDir, "assertions.json"))).toBe(false);
  });
});

describe("old format versions", () => {
  it("rejects negative version", () => {
    const error = validateBundle({ version: -1 });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("VERSION_MISMATCH");
  });

  it("rejects missing version", () => {
    const error = validateBundle({ id: "test" });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("MISSING_VERSION");
  });

  it("rejects non-object input", () => {
    expect(validateBundle(null)).not.toBeNull();
    expect(validateBundle("string")).not.toBeNull();
    expect(validateBundle(42)).not.toBeNull();
  });
});

describe("cross-platform paths", () => {
  it("handles Windows-style paths in meta without crashing", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-win1");
    createMinimalTrace(traceDir, {
      id: "r-win1",
      meta: { cwd: "C:\\Users\\dev\\project" },
    });

    const bundlePath = join(TEST_BASE, "win.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const bundle = readBundle(bundlePath);
    expect(bundle.meta.cwd).toBeUndefined();
  });

  it("preserves forward-slash paths in trace data", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-fwd1");
    const events: TraceEvent[] = [
      {
        seq: 0,
        type: "model.request",
        timestamp: "2026-08-25T10:00:00.000Z",
        data: { body: { file_path: "src/components/App.tsx" } },
      },
    ];
    createMinimalTrace(traceDir, { id: "r-fwd1", events, meta: { eventCount: 1 } });

    const bundlePath = join(TEST_BASE, "fwd.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });
    const imported = importBundle(bundlePath, importDir);

    const importedEvents = JSON.parse(
      readFileSync(join(imported.traceDir, "trace.json"), "utf-8"),
    );
    expect((importedEvents[0].data.body as Record<string, unknown>).file_path).toBe(
      "src/components/App.tsx",
    );
  });
});

describe("stableStringify determinism", () => {
  it("produces same output for different key orders", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("handles nested objects", () => {
    const a = { outer: { z: 1, a: 2 }, first: true };
    const b = { first: true, outer: { a: 2, z: 1 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("preserves array order", () => {
    const a = { items: [3, 1, 2] };
    const b = { items: [1, 2, 3] };
    expect(stableStringify(a)).not.toBe(stableStringify(b));
  });
});

describe("integrity verification", () => {
  it("detects meta tampering", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-int1");
    createMinimalTrace(traceDir, { id: "r-int1" });

    const bundlePath = join(TEST_BASE, "int.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const bundle = readBundle(bundlePath);
    (bundle.meta as Record<string, unknown>).command = ["evil"];
    bundle.checksum = "";
    bundle.checksum = sha256(stableStringify(bundle));
    writeFileSync(bundlePath, gzipSync(Buffer.from(stableStringify(bundle), "utf-8"), { level: 9 }));

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });

    expect(() => importBundle(bundlePath, importDir)).toThrow(/INTEGRITY_META/);
  });

  it("detects trace tampering", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-int2");
    createMinimalTrace(traceDir, { id: "r-int2" });

    const bundlePath = join(TEST_BASE, "int2.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const bundle = readBundle(bundlePath);
    bundle.trace.push({ seq: 99, type: "injected", timestamp: "2026-08-25T10:00:00.000Z", data: {} });
    bundle.checksum = "";
    bundle.checksum = sha256(stableStringify(bundle));
    writeFileSync(bundlePath, gzipSync(Buffer.from(stableStringify(bundle), "utf-8"), { level: 9 }));

    const importDir = join(TEST_BASE, ".repro-import");
    mkdirSync(importDir, { recursive: true });

    expect(() => importBundle(bundlePath, importDir)).toThrow(/INTEGRITY_TRACE/);
  });
});

describe("bundle metadata", () => {
  it("includes generator info", () => {
    const traceDir = join(TEST_BASE, ".repro", "r-meta1");
    createMinimalTrace(traceDir, { id: "r-meta1" });

    const bundlePath = join(TEST_BASE, "meta.repro");
    exportBundle(traceDir, bundlePath, "0.1.2");

    const bundle = readBundle(bundlePath);
    expect(bundle.generator).toBe("repro-md");
    expect(bundle.generatorVersion).toBe("0.1.2");
    expect(bundle.version).toBe(1);
    expect(bundle.created).toBeTruthy();
  });
});

const agentPath = join(
  import.meta.dirname,
  "..",
  "dist",
  "test-fixtures",
  "reference-agent.js",
);

async function spawnAgent(baseUrl: string, cwd: string): Promise<number> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [agentPath, "Read test-input.txt and write its content reversed to test-output.txt"],
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

describe("end-to-end: export → import → verify → replay", () => {
  it("full pipeline works", async () => {
    const repoDir = join(TEST_BASE, "e2e-repo");
    initGitRepo(repoDir);

    const stub = new StubUpstream({
      responses: [
        {
          content: [
            { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "test-input.txt" } },
          ],
          stop_reason: "tool_use",
        },
        {
          content: [
            { type: "tool_use", id: "toolu_02", name: "write_file", input: { path: "test-output.txt", content: "dlrow olleh" } },
          ],
          stop_reason: "tool_use",
        },
        {
          content: [{ type: "text", text: "Done!" }],
          stop_reason: "end_turn",
        },
      ],
    });
    const stubPort = await stub.start();

    const traceId = "r-e2e001";
    const traceDir = join(repoDir, ".repro", traceId);

    const proxy = new RecordingProxy({
      upstream: `http://127.0.0.1:${stubPort}`,
      traceDir,
      traceId,
      env: { ANTHROPIC_API_KEY: "sk-repro-dummy" },
    });
    const proxyPort = await proxy.start();
    await spawnAgent(`http://127.0.0.1:${proxyPort}`, repoDir);
    await proxy.stop();
    await stub.stop();

    const reader = new TraceReader(traceDir);
    const eventCount = reader.readEvents().length;
    const commit = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
    writeFileSync(
      join(traceDir, "meta.json"),
      JSON.stringify({
        id: traceId,
        command: [process.execPath, agentPath, "Read test-input.txt and write its content reversed to test-output.txt"],
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        eventCount,
        commit,
        cwd: repoDir,
      }, null, 2) + "\n",
      "utf-8",
    );

    const assertions: AssertionDef[] = [
      { type: "max_calls", args: { max: 10 } },
      { type: "forbidden_path", args: { pattern: "danger/**" } },
    ];
    writeFileSync(join(traceDir, "assertions.json"), JSON.stringify(assertions, null, 2) + "\n", "utf-8");

    // Export
    const bundlePath = join(TEST_BASE, "e2e.repro");
    const exportResult = exportBundle(traceDir, bundlePath, "0.1.2");
    expect(exportResult.id).toBe(traceId);
    expect(existsSync(bundlePath)).toBe(true);

    // Import into a different repo
    const importRepo = join(TEST_BASE, "e2e-import-repo");
    initGitRepo(importRepo);

    const importReproDir = join(importRepo, ".repro");
    mkdirSync(importReproDir, { recursive: true });
    const importResult = importBundle(bundlePath, importReproDir);
    expect(importResult.id).toBe(traceId);

    // Verify: read and validate the imported trace
    const importedReader = new TraceReader(importResult.traceDir);
    const importedMeta = importedReader.readMeta();
    expect(importedMeta.id).toBe(traceId);

    const importedEvents = importedReader.readResolvedEvents();
    expect(importedEvents.length).toBeGreaterThan(0);

    // Replay using the imported trace
    execSync("git add -A && git commit -m 'add repro'", { cwd: importRepo, stdio: "pipe" });

    const replayProxy = new ReplayProxy({
      traceDir: importResult.traceDir,
      strict: false,
    });
    const replayPort = await replayProxy.start();

    const worktree = createWorktree(importRepo);
    const replayCode = await spawnAgent(`http://127.0.0.1:${replayPort}`, worktree.path);
    await replayProxy.stop();

    const events = importedReader.readResolvedEvents();
    const assertionResults = evaluateAssertions(assertions, events, worktree.path);

    removeWorktree(importRepo, worktree.path);

    expect(replayCode).toBe(0);
    expect(assertionResults.every((r) => r.passed)).toBe(true);
  }, 60000);
});

describe("validateBundle edge cases", () => {
  it("rejects missing id", () => {
    const error = validateBundle({ version: 1 });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("MISSING_ID");
  });

  it("rejects missing meta", () => {
    const b: Record<string, unknown> = {
      version: 1,
      id: "test",
      checksum: "x",
      trace: [],
      integrity: {},
    };
    b.checksum = "";
    b.checksum = sha256(stableStringify(b));
    const error = validateBundle(b);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("MISSING_META");
  });

  it("rejects missing trace", () => {
    const b: Record<string, unknown> = {
      version: 1,
      id: "test",
      checksum: "x",
      meta: {},
      integrity: {},
    };
    b.checksum = "";
    b.checksum = sha256(stableStringify(b));
    const error = validateBundle(b);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("MISSING_TRACE");
  });
});
