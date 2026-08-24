import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RecordingProxy } from "../src/proxy.js";
import { StubUpstream } from "../src/test-fixtures/stub-upstream.js";
import { SessionSplitter } from "../src/session-splitter.js";
import { TraceReader } from "../src/trace.js";

const TEST_BASE = join(
  import.meta.dirname,
  "..",
  ".test-splitter-" + process.pid,
);

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_BASE, { recursive: true, force: true });
});

async function sendRequest(
  port: number,
  messageContent = "hello",
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "sk-repro-dummy",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: messageContent }],
    }),
  });
}

describe("session splitter", () => {
  it("keeps requests within idle window in the same trace", async () => {
    const tracesDir = join(TEST_BASE, "traces");
    mkdirSync(tracesDir, { recursive: true });

    const stub = new StubUpstream({
      responses: [
        {
          content: [{ type: "text", text: "Response 1" }],
          stop_reason: "end_turn",
        },
        {
          content: [{ type: "text", text: "Response 2" }],
          stop_reason: "end_turn",
        },
      ],
    });
    const stubPort = await stub.start();

    let exchangeHandler: (() => void) | null = null;
    const firstTraceDir = join(tracesDir, "r-first1");

    const proxy = new RecordingProxy({
      upstream: `http://127.0.0.1:${stubPort}`,
      traceDir: firstTraceDir,
      traceId: "r-first1",
      env: { ANTHROPIC_API_KEY: "sk-repro-dummy" },
      onExchangeComplete: () => exchangeHandler?.(),
    });

    const splitter = new SessionSplitter({
      idleSplitMs: 5000,
      tracesDir,
      initialId: "r-first1",
      initialDir: firstTraceDir,
      getEventCount: () => proxy.getTraceWriter().getEventCount(),
      finalizeTrace: () => proxy.getTraceWriter().finalize(),
      writeMeta: (meta) => proxy.getTraceWriter().writeMeta(meta),
      resetTrace: (dir) => proxy.resetTrace(dir),
    });
    exchangeHandler = () => splitter.onExchangeComplete();

    const proxyPort = await proxy.start();

    try {
      await sendRequest(proxyPort, "request 1");
      await sendRequest(proxyPort, "request 2");

      expect(splitter.getCompletedSessions()).toHaveLength(0);

      proxy.getTraceWriter().finalize();
      const reader = new TraceReader(splitter.getCurrentDir());
      const events = reader.readEvents();
      expect(events.filter((e) => e.type === "model.request")).toHaveLength(2);
      expect(events.filter((e) => e.type === "model.response")).toHaveLength(2);
    } finally {
      splitter.destroy();
      await proxy.stop();
      await stub.stop();
    }
  }, 15000);

  it("splits into separate traces after idle timeout", async () => {
    vi.useFakeTimers();

    const tracesDir = join(TEST_BASE, "traces");
    mkdirSync(tracesDir, { recursive: true });

    const stub = new StubUpstream({
      responses: [
        {
          content: [{ type: "text", text: "Response 1" }],
          stop_reason: "end_turn",
        },
        {
          content: [{ type: "text", text: "Response 2" }],
          stop_reason: "end_turn",
        },
        {
          content: [{ type: "text", text: "Response 3" }],
          stop_reason: "end_turn",
        },
        {
          content: [{ type: "text", text: "Response 4" }],
          stop_reason: "end_turn",
        },
        {
          content: [{ type: "text", text: "Response 5" }],
          stop_reason: "end_turn",
        },
      ],
    });
    const stubPort = await stub.start();

    let exchangeHandler: (() => void) | null = null;
    const firstTraceDir = join(tracesDir, "r-split1");

    const proxy = new RecordingProxy({
      upstream: `http://127.0.0.1:${stubPort}`,
      traceDir: firstTraceDir,
      traceId: "r-split1",
      env: { ANTHROPIC_API_KEY: "sk-repro-dummy" },
      onExchangeComplete: () => exchangeHandler?.(),
    });

    const idleSplitMs = 2000;
    const splitter = new SessionSplitter({
      idleSplitMs,
      tracesDir,
      initialId: "r-split1",
      initialDir: firstTraceDir,
      getEventCount: () => proxy.getTraceWriter().getEventCount(),
      finalizeTrace: () => proxy.getTraceWriter().finalize(),
      writeMeta: (meta) => proxy.getTraceWriter().writeMeta(meta),
      resetTrace: (dir) => proxy.resetTrace(dir),
    });
    exchangeHandler = () => splitter.onExchangeComplete();

    const proxyPort = await proxy.start();

    try {
      await sendRequest(proxyPort, "batch 1 req 1");
      await sendRequest(proxyPort, "batch 1 req 2");
      await sendRequest(proxyPort, "batch 1 req 3");

      vi.advanceTimersByTime(idleSplitMs + 100);

      const sessions = splitter.getCompletedSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].meta.eventCount).toBe(6);

      const reader1 = new TraceReader(sessions[0].traceDir);
      const events1 = reader1.readEvents();
      expect(events1.filter((e) => e.type === "model.request")).toHaveLength(3);
      expect(events1.filter((e) => e.type === "model.response")).toHaveLength(
        3,
      );

      await sendRequest(proxyPort, "batch 2 req 1");
      await sendRequest(proxyPort, "batch 2 req 2");

      vi.advanceTimersByTime(idleSplitMs + 100);

      const allSessions = splitter.getCompletedSessions();
      expect(allSessions).toHaveLength(2);
      expect(allSessions[1].meta.eventCount).toBe(4);
    } finally {
      splitter.destroy();
      vi.useRealTimers();
      await proxy.stop();
      await stub.stop();
    }
  }, 30000);

  it("produces valid traces that TraceReader can parse", async () => {
    vi.useFakeTimers();

    const tracesDir = join(TEST_BASE, "traces");
    mkdirSync(tracesDir, { recursive: true });

    const stub = new StubUpstream({
      responses: [
        {
          content: [{ type: "text", text: "Hello" }],
          stop_reason: "end_turn",
        },
      ],
    });
    const stubPort = await stub.start();

    let exchangeHandler: (() => void) | null = null;
    const firstTraceDir = join(tracesDir, "r-valid1");

    const proxy = new RecordingProxy({
      upstream: `http://127.0.0.1:${stubPort}`,
      traceDir: firstTraceDir,
      traceId: "r-valid1",
      env: { ANTHROPIC_API_KEY: "sk-repro-dummy" },
      onExchangeComplete: () => exchangeHandler?.(),
    });

    const splitter = new SessionSplitter({
      idleSplitMs: 1000,
      tracesDir,
      initialId: "r-valid1",
      initialDir: firstTraceDir,
      getEventCount: () => proxy.getTraceWriter().getEventCount(),
      finalizeTrace: () => proxy.getTraceWriter().finalize(),
      writeMeta: (meta) => proxy.getTraceWriter().writeMeta(meta),
      resetTrace: (dir) => proxy.resetTrace(dir),
    });
    exchangeHandler = () => splitter.onExchangeComplete();

    const proxyPort = await proxy.start();

    try {
      await sendRequest(proxyPort, "test");

      vi.advanceTimersByTime(1100);

      const sessions = splitter.getCompletedSessions();
      expect(sessions).toHaveLength(1);

      const reader = new TraceReader(sessions[0].traceDir);
      expect(reader.exists()).toBe(true);

      const meta = reader.readMeta();
      expect(meta.id).toBeDefined();
      expect(meta.command).toEqual(["daemon"]);
      expect(meta.eventCount).toBe(2);
      expect(meta.startTime).toBeDefined();
      expect(meta.endTime).toBeDefined();

      const events = reader.readEvents();
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("model.request");
      expect(events[1].type).toBe("model.response");
    } finally {
      splitter.destroy();
      vi.useRealTimers();
      await proxy.stop();
      await stub.stop();
    }
  }, 15000);

  it("does not create empty traces on idle timeout with no requests", async () => {
    vi.useFakeTimers();

    const tracesDir = join(TEST_BASE, "traces");
    mkdirSync(tracesDir, { recursive: true });

    const stub = new StubUpstream({
      responses: [
        {
          content: [{ type: "text", text: "Hello" }],
          stop_reason: "end_turn",
        },
      ],
    });
    const stubPort = await stub.start();

    let exchangeHandler: (() => void) | null = null;
    const firstTraceDir = join(tracesDir, "r-empty1");

    const proxy = new RecordingProxy({
      upstream: `http://127.0.0.1:${stubPort}`,
      traceDir: firstTraceDir,
      traceId: "r-empty1",
      env: { ANTHROPIC_API_KEY: "sk-repro-dummy" },
      onExchangeComplete: () => exchangeHandler?.(),
    });

    const splitter = new SessionSplitter({
      idleSplitMs: 1000,
      tracesDir,
      initialId: "r-empty1",
      initialDir: firstTraceDir,
      getEventCount: () => proxy.getTraceWriter().getEventCount(),
      finalizeTrace: () => proxy.getTraceWriter().finalize(),
      writeMeta: (meta) => proxy.getTraceWriter().writeMeta(meta),
      resetTrace: (dir) => proxy.resetTrace(dir),
    });
    exchangeHandler = () => splitter.onExchangeComplete();

    await proxy.start();

    try {
      await sendRequest(await proxy.getPort(), "test");
      vi.advanceTimersByTime(1100);

      expect(splitter.getCompletedSessions()).toHaveLength(1);

      vi.advanceTimersByTime(2000);

      expect(splitter.getCompletedSessions()).toHaveLength(1);
    } finally {
      splitter.destroy();
      vi.useRealTimers();
      await proxy.stop();
      await stub.stop();
    }
  }, 15000);

  it("finalizeCurrentSession saves in-progress session", async () => {
    const tracesDir = join(TEST_BASE, "traces");
    mkdirSync(tracesDir, { recursive: true });

    const stub = new StubUpstream({
      responses: [
        {
          content: [{ type: "text", text: "Response" }],
          stop_reason: "end_turn",
        },
      ],
    });
    const stubPort = await stub.start();

    let exchangeHandler: (() => void) | null = null;
    const firstTraceDir = join(tracesDir, "r-final1");

    const proxy = new RecordingProxy({
      upstream: `http://127.0.0.1:${stubPort}`,
      traceDir: firstTraceDir,
      traceId: "r-final1",
      env: { ANTHROPIC_API_KEY: "sk-repro-dummy" },
      onExchangeComplete: () => exchangeHandler?.(),
    });

    const splitter = new SessionSplitter({
      idleSplitMs: 60000,
      tracesDir,
      initialId: "r-final1",
      initialDir: firstTraceDir,
      getEventCount: () => proxy.getTraceWriter().getEventCount(),
      finalizeTrace: () => proxy.getTraceWriter().finalize(),
      writeMeta: (meta) => proxy.getTraceWriter().writeMeta(meta),
      resetTrace: (dir) => proxy.resetTrace(dir),
    });
    exchangeHandler = () => splitter.onExchangeComplete();

    const proxyPort = await proxy.start();

    try {
      await sendRequest(proxyPort, "in-progress");

      const session = splitter.finalizeCurrentSession();
      expect(session).not.toBeNull();
      expect(session!.meta.eventCount).toBe(2);

      const reader = new TraceReader(session!.traceDir);
      expect(reader.exists()).toBe(true);
      const events = reader.readEvents();
      expect(events).toHaveLength(2);
    } finally {
      splitter.destroy();
      await proxy.stop();
      await stub.stop();
    }
  }, 15000);
});
