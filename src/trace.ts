import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TraceEvent, TraceMeta } from "./types.js";
import { writeBlobIfNeeded, resolveBlob } from "./blob.js";

export class TraceWriter {
  private seq = 0;
  private readonly traceDir: string;
  private readonly blobDir: string;
  private readonly tracePath: string;
  private readonly blobThreshold: number;
  private initialized = false;
  private finalized = false;

  constructor(traceDir: string, blobThreshold = 10 * 1024) {
    this.traceDir = traceDir;
    this.blobDir = join(traceDir, "blobs");
    this.tracePath = join(traceDir, "trace.json");
    this.blobThreshold = blobThreshold;
  }

  init(): void {
    mkdirSync(this.traceDir, { recursive: true });
    writeFileSync(this.tracePath, "[\n", "utf-8");
    this.initialized = true;
  }

  append(type: string, data: Record<string, unknown>): TraceEvent {
    if (!this.initialized) this.init();

    const event: TraceEvent = {
      seq: this.seq++,
      type,
      timestamp: new Date().toISOString(),
      data: this.externalizeBlobFields(data),
    };

    const prefix = event.seq === 0 ? "" : ",\n";
    appendFileSync(
      this.tracePath,
      prefix + JSON.stringify(event, null, 2),
      "utf-8",
    );

    return event;
  }

  finalize(): void {
    if (!this.initialized || this.finalized) return;
    this.finalized = true;
    appendFileSync(this.tracePath, "\n]\n", "utf-8");
  }

  writeMeta(meta: TraceMeta): void {
    const metaPath = join(this.traceDir, "meta.json");
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  }

  getEventCount(): number {
    return this.seq;
  }

  private externalizeBlobFields(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = writeBlobIfNeeded(value, this.blobDir, this.blobThreshold);
    }
    return result;
  }
}

export class TraceReader {
  private readonly traceDir: string;
  private readonly blobDir: string;

  constructor(traceDir: string) {
    this.traceDir = traceDir;
    this.blobDir = join(traceDir, "blobs");
  }

  readEvents(): TraceEvent[] {
    const tracePath = join(this.traceDir, "trace.json");
    const content = readFileSync(tracePath, "utf-8");
    return JSON.parse(content);
  }

  readMeta(): TraceMeta {
    const metaPath = join(this.traceDir, "meta.json");
    const content = readFileSync(metaPath, "utf-8");
    return JSON.parse(content);
  }

  resolveBlob(value: unknown): unknown {
    return resolveBlob(value, this.blobDir);
  }

  resolveEventData(event: TraceEvent): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event.data)) {
      resolved[key] = this.resolveBlob(value);
    }
    return resolved;
  }

  readResolvedEvents(): TraceEvent[] {
    return this.readEvents().map((event) => ({
      ...event,
      data: this.resolveEventData(event),
    }));
  }

  exists(): boolean {
    return existsSync(join(this.traceDir, "trace.json"));
  }
}
