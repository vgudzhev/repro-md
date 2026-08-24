import { generateTraceId } from "./id.js";
import { join } from "node:path";
import type { TraceMeta } from "./types.js";

export interface SessionSplitterCallbacks {
  getEventCount: () => number;
  finalizeTrace: () => void;
  writeMeta: (meta: TraceMeta) => void;
  resetTrace: (traceDir: string) => void;
}

export interface SessionSplitterOptions extends SessionSplitterCallbacks {
  idleSplitMs: number;
  tracesDir: string;
  initialId: string;
  initialDir: string;
}

export interface CompletedSession {
  id: string;
  traceDir: string;
  meta: TraceMeta;
}

export class SessionSplitter {
  private readonly idleSplitMs: number;
  private readonly tracesDir: string;
  private readonly callbacks: SessionSplitterCallbacks;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private currentId: string;
  private currentDir: string;
  private sessionStartTime: string;
  private readonly completedSessions: CompletedSession[] = [];

  constructor(options: SessionSplitterOptions) {
    this.idleSplitMs = options.idleSplitMs;
    this.tracesDir = options.tracesDir;
    this.callbacks = {
      getEventCount: options.getEventCount,
      finalizeTrace: options.finalizeTrace,
      writeMeta: options.writeMeta,
      resetTrace: options.resetTrace,
    };

    this.currentId = options.initialId;
    this.currentDir = options.initialDir;
    this.sessionStartTime = new Date().toISOString();
  }

  getCurrentId(): string {
    return this.currentId;
  }

  getCurrentDir(): string {
    return this.currentDir;
  }

  getCompletedSessions(): CompletedSession[] {
    return [...this.completedSessions];
  }

  onExchangeComplete(): void {
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => this.splitSession(), this.idleSplitMs);
  }

  private splitSession(): void {
    this.idleTimer = null;
    const eventCount = this.callbacks.getEventCount();
    if (eventCount === 0) return;

    const meta: TraceMeta = {
      id: this.currentId,
      command: ["daemon"],
      startTime: this.sessionStartTime,
      endTime: new Date().toISOString(),
      eventCount,
    };

    this.callbacks.finalizeTrace();
    this.callbacks.writeMeta(meta);

    this.completedSessions.push({
      id: this.currentId,
      traceDir: this.currentDir,
      meta,
    });

    this.currentId = generateTraceId();
    this.currentDir = join(this.tracesDir, this.currentId);
    this.sessionStartTime = new Date().toISOString();

    this.callbacks.resetTrace(this.currentDir);
  }

  finalizeCurrentSession(): CompletedSession | null {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const eventCount = this.callbacks.getEventCount();
    if (eventCount === 0) return null;

    const meta: TraceMeta = {
      id: this.currentId,
      command: ["daemon"],
      startTime: this.sessionStartTime,
      endTime: new Date().toISOString(),
      eventCount,
    };

    this.callbacks.finalizeTrace();
    this.callbacks.writeMeta(meta);

    const session: CompletedSession = {
      id: this.currentId,
      traceDir: this.currentDir,
      meta,
    };
    this.completedSessions.push(session);
    return session;
  }

  destroy(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
