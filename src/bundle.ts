import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import type { TraceMeta, TraceEvent, AssertionDef } from "./types.js";
import { redactSecrets } from "./redact.js";
import { generateTraceId } from "./id.js";

const BUNDLE_FORMAT_VERSION = 1;
const BUNDLE_GENERATOR = "repro-md";

export interface Bundle {
  version: number;
  generator: string;
  generatorVersion: string;
  id: string;
  created: string;
  checksum: string;
  meta: TraceMeta;
  trace: TraceEvent[];
  assertions: AssertionDef[] | null;
  blobs: Record<string, string>;
  integrity: Record<string, string>;
}

export interface SecurityFinding {
  type: "secret" | "absolute_path" | "sensitive_file" | "redacted_marker";
  location: string;
  detail: string;
  severity: "high" | "medium" | "low";
}

export interface SecurityCheckResult {
  safe: boolean;
  findings: SecurityFinding[];
}

export interface ExportResult {
  outputPath: string;
  id: string;
  checksum: string;
  security: SecurityCheckResult;
}

export interface ImportResult {
  id: string;
  originalId: string;
  traceDir: string;
  idChanged: boolean;
}

export interface BundleValidationError {
  code: string;
  message: string;
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

function sanitizeMeta(meta: TraceMeta): TraceMeta {
  const sanitized = { ...meta };
  delete sanitized.cwd;
  return sanitized;
}

function scanContent(content: string, location: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  const redacted = redactSecrets(content);
  if (redacted !== content) {
    findings.push({
      type: "secret",
      location,
      detail: "Content contains patterns matching known secret formats",
      severity: "high",
    });
  }

  if (content.includes("[[redacted:")) {
    findings.push({
      type: "redacted_marker",
      location,
      detail: "Content contains redaction markers (previously redacted)",
      severity: "low",
    });
  }

  const absPathPattern =
    /(?:\/(?:home|Users|tmp|var|etc|opt|usr)\/\S+|[A-Z]:\\\\?\S+)/g;
  const matches = content.match(absPathPattern);
  if (matches) {
    const uniquePaths = [...new Set(matches)].slice(0, 5);
    findings.push({
      type: "absolute_path",
      location,
      detail: `Contains absolute paths: ${uniquePaths.join(", ")}${matches.length > 5 ? ` (and ${matches.length - 5} more)` : ""}`,
      severity: "medium",
    });
  }

  return findings;
}

export function checkBundleSecurity(traceDir: string): SecurityCheckResult {
  const findings: SecurityFinding[] = [];

  const metaPath = join(traceDir, "meta.json");
  if (existsSync(metaPath)) {
    findings.push(...scanContent(readFileSync(metaPath, "utf-8"), "meta.json"));
  }

  const tracePath = join(traceDir, "trace.json");
  if (existsSync(tracePath)) {
    findings.push(
      ...scanContent(readFileSync(tracePath, "utf-8"), "trace.json"),
    );
  }

  const assertPath = join(traceDir, "assertions.json");
  if (existsSync(assertPath)) {
    findings.push(
      ...scanContent(readFileSync(assertPath, "utf-8"), "assertions.json"),
    );
  }

  const blobDir = join(traceDir, "blobs");
  if (existsSync(blobDir)) {
    for (const blobFile of readdirSync(blobDir)) {
      findings.push(
        ...scanContent(
          readFileSync(join(blobDir, blobFile), "utf-8"),
          `blobs/${blobFile}`,
        ),
      );
    }
  }

  return {
    safe: !findings.some((f) => f.severity === "high"),
    findings,
  };
}

export function exportBundle(
  traceDir: string,
  outputPath: string,
  generatorVersion: string,
): ExportResult {
  const meta: TraceMeta = JSON.parse(
    readFileSync(join(traceDir, "meta.json"), "utf-8"),
  );
  const trace: TraceEvent[] = JSON.parse(
    readFileSync(join(traceDir, "trace.json"), "utf-8"),
  );

  const assertPath = join(traceDir, "assertions.json");
  const assertions: AssertionDef[] | null = existsSync(assertPath)
    ? JSON.parse(readFileSync(assertPath, "utf-8"))
    : null;

  const blobs: Record<string, string> = {};
  const blobDir = join(traceDir, "blobs");
  if (existsSync(blobDir)) {
    for (const blobFile of readdirSync(blobDir)) {
      blobs[blobFile] = readFileSync(join(blobDir, blobFile), "utf-8");
    }
  }

  const security = checkBundleSecurity(traceDir);
  const sanitizedMeta = sanitizeMeta(meta);

  const integrity: Record<string, string> = {
    meta: sha256(stableStringify(sanitizedMeta)),
    trace: sha256(stableStringify(trace)),
  };
  if (assertions !== null) {
    integrity.assertions = sha256(stableStringify(assertions));
  }
  for (const [hash, content] of Object.entries(blobs)) {
    integrity[`blob:${hash}`] = sha256(content);
  }

  const bundle: Bundle = {
    version: BUNDLE_FORMAT_VERSION,
    generator: BUNDLE_GENERATOR,
    generatorVersion,
    id: meta.id,
    created: new Date().toISOString(),
    checksum: "",
    meta: sanitizedMeta,
    trace,
    assertions,
    blobs,
    integrity,
  };

  bundle.checksum = sha256(stableStringify(bundle));

  const json = stableStringify(bundle);
  const compressed = gzipSync(Buffer.from(json, "utf-8"), { level: 9 });
  writeFileSync(outputPath, compressed);

  return {
    outputPath,
    id: meta.id,
    checksum: bundle.checksum,
    security,
  };
}

export function validateBundle(bundle: unknown): BundleValidationError | null {
  if (typeof bundle !== "object" || bundle === null) {
    return { code: "INVALID_STRUCTURE", message: "Bundle is not an object" };
  }

  const b = bundle as Record<string, unknown>;

  if (typeof b.version !== "number") {
    return { code: "MISSING_VERSION", message: "Bundle missing version field" };
  }
  if (b.version > BUNDLE_FORMAT_VERSION) {
    return {
      code: "VERSION_MISMATCH",
      message: `Bundle version ${b.version} is newer than supported version ${BUNDLE_FORMAT_VERSION}`,
    };
  }
  if (b.version < 1) {
    return {
      code: "VERSION_MISMATCH",
      message: `Bundle version ${b.version} is not supported`,
    };
  }

  if (typeof b.id !== "string" || !b.id) {
    return { code: "MISSING_ID", message: "Bundle missing id field" };
  }
  if (typeof b.checksum !== "string" || !b.checksum) {
    return {
      code: "MISSING_CHECKSUM",
      message: "Bundle missing checksum field",
    };
  }
  if (!b.meta || typeof b.meta !== "object") {
    return { code: "MISSING_META", message: "Bundle missing meta field" };
  }
  if (!Array.isArray(b.trace)) {
    return { code: "MISSING_TRACE", message: "Bundle missing trace field" };
  }
  if (!b.integrity || typeof b.integrity !== "object") {
    return {
      code: "MISSING_INTEGRITY",
      message: "Bundle missing integrity field",
    };
  }

  const storedChecksum = b.checksum as string;
  const withEmptyChecksum = { ...b, checksum: "" };
  const computedChecksum = sha256(stableStringify(withEmptyChecksum));
  if (storedChecksum !== computedChecksum) {
    return {
      code: "CHECKSUM_MISMATCH",
      message: "Bundle checksum verification failed — contents may be tampered",
    };
  }

  const integrity = b.integrity as Record<string, string>;

  if (integrity.meta && sha256(stableStringify(b.meta)) !== integrity.meta) {
    return { code: "INTEGRITY_META", message: "Meta integrity check failed" };
  }

  if (
    integrity.trace &&
    sha256(stableStringify(b.trace)) !== integrity.trace
  ) {
    return {
      code: "INTEGRITY_TRACE",
      message: "Trace integrity check failed",
    };
  }

  if (b.assertions !== null && b.assertions !== undefined) {
    if (
      integrity.assertions &&
      sha256(stableStringify(b.assertions)) !== integrity.assertions
    ) {
      return {
        code: "INTEGRITY_ASSERTIONS",
        message: "Assertions integrity check failed",
      };
    }
  }

  const blobs = (b.blobs ?? {}) as Record<string, string>;
  for (const [hash, content] of Object.entries(blobs)) {
    const integrityKey = `blob:${hash}`;
    if (integrity[integrityKey] && sha256(content) !== integrity[integrityKey]) {
      return {
        code: "INTEGRITY_BLOB",
        message: `Blob ${hash} integrity check failed`,
      };
    }
    if (sha256(content) !== hash) {
      return {
        code: "BLOB_HASH_MISMATCH",
        message: `Blob ${hash} content does not match its content-address key`,
      };
    }
  }

  for (const event of b.trace as TraceEvent[]) {
    for (const value of Object.values(event.data)) {
      if (typeof value === "string" && value.startsWith("blob:sha256-")) {
        const blobHash = value.slice("blob:sha256-".length);
        if (!blobs[blobHash]) {
          return {
            code: "MISSING_BLOB",
            message: `Blob ${blobHash} referenced in trace but not in bundle`,
          };
        }
      }
    }
  }

  return null;
}

export function readBundle(bundlePath: string): Bundle {
  const compressed = readFileSync(bundlePath);
  let json: string;
  try {
    json = gunzipSync(compressed).toString("utf-8");
  } catch {
    throw new Error(
      "Failed to decompress bundle — file may be corrupted or not a .repro bundle",
    );
  }

  let bundle: Bundle;
  try {
    bundle = JSON.parse(json) as Bundle;
  } catch {
    throw new Error("Failed to parse bundle JSON — file may be corrupted");
  }

  return bundle;
}

export function importBundle(
  bundlePath: string,
  reproDir: string,
): ImportResult {
  const bundle = readBundle(bundlePath);

  const validationError = validateBundle(bundle);
  if (validationError) {
    throw new Error(
      `Bundle validation failed: ${validationError.message} (${validationError.code})`,
    );
  }

  let id = bundle.id;
  let idChanged = false;
  const targetDir = join(reproDir, id);
  if (existsSync(targetDir)) {
    id = generateTraceId();
    idChanged = true;
  }

  const traceDir = join(reproDir, id);
  mkdirSync(traceDir, { recursive: true });

  const meta = { ...bundle.meta, id };
  writeFileSync(
    join(traceDir, "meta.json"),
    JSON.stringify(meta, null, 2) + "\n",
    "utf-8",
  );

  writeFileSync(
    join(traceDir, "trace.json"),
    JSON.stringify(bundle.trace, null, 2) + "\n",
    "utf-8",
  );

  if (bundle.assertions !== null && bundle.assertions !== undefined) {
    writeFileSync(
      join(traceDir, "assertions.json"),
      JSON.stringify(bundle.assertions, null, 2) + "\n",
      "utf-8",
    );
  }

  if (Object.keys(bundle.blobs).length > 0) {
    const blobDir = join(traceDir, "blobs");
    mkdirSync(blobDir, { recursive: true });
    for (const [hash, content] of Object.entries(bundle.blobs)) {
      writeFileSync(join(blobDir, hash), content, "utf-8");
    }
  }

  return { id, originalId: bundle.id, traceDir, idChanged };
}

export { BUNDLE_FORMAT_VERSION, BUNDLE_GENERATOR };
