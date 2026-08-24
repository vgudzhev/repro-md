import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { RecordingProxy } from "../src/proxy.js";
import { StubUpstream } from "../src/test-fixtures/stub-upstream.js";
import { SessionSplitter } from "../src/session-splitter.js";
import { TraceReader } from "../src/trace.js";
import { pruneTraces, listDaemonTraces } from "../src/retention.js";
import type { DaemonConfig, TraceMeta } from "../src/types.js";

const TEST_BASE = join(
  import.meta.dirname,
  "..",
  ".test-daemon-" + process.pid,
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

describe("daemon proxy behaves identically to record proxy", () => {
  it("produces same trace structure as record proxy", async () => {
    const tracesDir = join(TEST_BASE, "traces");
    mkdirSync(tracesDir, { recursive: true });

    const stub = new StubUpstream({
      responses: [
        {
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "read_file",
              input: { path: "test.txt" },
            },
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

    let exchangeHandler: (() => void) | null = null;
    const firstTraceDir = join(tracesDir, "r-daemon1");

    const proxy = new RecordingProxy({
      upstream: `http://127.0.0.1:${stubPort}`,
      traceDir: firstTraceDir,
      traceId: "r-daemon1",
      env: { ANTHROPIC_API_KEY: "sk-repro-dummy" },
      onExchangeComplete: () => exchangeHandler?.(),
    });

    const splitter = new SessionSplitter({
      idleSplitMs: 60000,
      tracesDir,
      initialId: "r-daemon1",
      initialDir: firstTraceDir,
      getEventCount: () => proxy.getTraceWriter().getEventCount(),
      finalizeTrace: () => proxy.getTraceWriter().finalize(),
      writeMeta: (meta) => proxy.getTraceWriter().writeMeta(meta),
      resetTrace: (dir) => proxy.resetTrace(dir),
    });
    exchangeHandler = () => splitter.onExchangeComplete();

    const proxyPort = await proxy.start();

    try {
      const res1 = await sendRequest(proxyPort, "request 1");
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.content[0].name).toBe("read_file");

      const res2 = await sendRequest(proxyPort, "request 2");
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.content[0].text).toBe("Done!");

      const session = splitter.finalizeCurrentSession();
      expect(session).not.toBeNull();

      const reader = new TraceReader(session!.traceDir);
      expect(reader.exists()).toBe(true);

      const events = reader.readEvents();
      expect(events.filter((e) => e.type === "model.request")).toHaveLength(2);
      expect(events.filter((e) => e.type === "model.response")).toHaveLength(2);

      const firstReq = events.find((e) => e.type === "model.request")!;
      expect(firstReq.data.normalizedHash).toBeDefined();
      expect(firstReq.data.messageHashes).toBeDefined();
      expect(firstReq.data.headers).toBeDefined();

      const firstRes = events.find((e) => e.type === "model.response")!;
      expect(firstRes.data.body).toBeDefined();
      expect(firstRes.data.streaming).toBe(false);
    } finally {
      splitter.destroy();
      await proxy.stop();
      await stub.stop();
    }
  }, 15000);

  it("redacts secrets identically to record proxy", async () => {
    const tracesDir = join(TEST_BASE, "traces");
    mkdirSync(tracesDir, { recursive: true });

    const fakeSecret =
      "sk-ant-api03-FAKE-SECRET-FOR-DAEMON-TEST-abcdef123456";

    const stub = new StubUpstream({
      responses: [
        {
          content: [
            { type: "text", text: `Secret is ${fakeSecret}` },
          ],
          stop_reason: "end_turn",
        },
      ],
    });
    const stubPort = await stub.start();

    let exchangeHandler: (() => void) | null = null;
    const firstTraceDir = join(tracesDir, "r-redact1");

    const proxy = new RecordingProxy({
      upstream: `http://127.0.0.1:${stubPort}`,
      traceDir: firstTraceDir,
      traceId: "r-redact1",
      env: {
        ANTHROPIC_API_KEY: fakeSecret,
        MY_DAEMON_SECRET: "daemon-secret-value-sensitive",
      },
      onExchangeComplete: () => exchangeHandler?.(),
    });

    const splitter = new SessionSplitter({
      idleSplitMs: 60000,
      tracesDir,
      initialId: "r-redact1",
      initialDir: firstTraceDir,
      getEventCount: () => proxy.getTraceWriter().getEventCount(),
      finalizeTrace: () => proxy.getTraceWriter().finalize(),
      writeMeta: (meta) => proxy.getTraceWriter().writeMeta(meta),
      resetTrace: (dir) => proxy.resetTrace(dir),
    });
    exchangeHandler = () => splitter.onExchangeComplete();

    const proxyPort = await proxy.start();

    try {
      await sendRequest(proxyPort, `My key is ${fakeSecret}`);

      const session = splitter.finalizeCurrentSession();
      expect(session).not.toBeNull();

      const traceContent = readFileSync(
        join(session!.traceDir, "trace.json"),
        "utf-8",
      );
      expect(traceContent).not.toContain(fakeSecret);
      expect(traceContent).not.toContain("daemon-secret-value-sensitive");
      expect(traceContent).toContain("[[redacted:");
    } finally {
      splitter.destroy();
      await proxy.stop();
      await stub.stop();
    }
  }, 15000);
});

describe("retention integration", () => {
  it("prunes oldest traces keeping max_traces", () => {
    const tracesDir = join(TEST_BASE, "traces");
    mkdirSync(tracesDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      const id = `r-prn00${i}`;
      const dir = join(tracesDir, id);
      mkdirSync(dir, { recursive: true });
      const meta: TraceMeta = {
        id,
        command: ["daemon"],
        startTime: new Date(Date.now() - (5 - i) * 1000).toISOString(),
        eventCount: 2,
      };
      writeFileSync(join(dir, "meta.json"), JSON.stringify(meta), "utf-8");
      writeFileSync(join(dir, "trace.json"), "[]", "utf-8");
    }

    const config: DaemonConfig = {
      idle_split_seconds: 120,
      retention_days: 365,
      max_traces: 3,
      max_disk_mb: 500,
      port: 7717,
    };

    const pruned = pruneTraces(tracesDir, config, new Set());
    expect(pruned).toBe(2);

    const remaining = listDaemonTraces(tracesDir);
    expect(remaining).toHaveLength(3);
  });
});

describe("streaming through daemon proxy", () => {
  it("records streaming responses correctly", async () => {
    const tracesDir = join(TEST_BASE, "traces");
    mkdirSync(tracesDir, { recursive: true });

    const stub = new StubUpstream({
      responses: [
        {
          content: [{ type: "text", text: "Streamed response!" }],
          stop_reason: "end_turn",
        },
      ],
    });
    const stubPort = await stub.start();

    let exchangeHandler: (() => void) | null = null;
    const firstTraceDir = join(tracesDir, "r-stream1");

    const proxy = new RecordingProxy({
      upstream: `http://127.0.0.1:${stubPort}`,
      traceDir: firstTraceDir,
      traceId: "r-stream1",
      env: { ANTHROPIC_API_KEY: "sk-repro-dummy" },
      onExchangeComplete: () => exchangeHandler?.(),
    });

    const splitter = new SessionSplitter({
      idleSplitMs: 60000,
      tracesDir,
      initialId: "r-stream1",
      initialDir: firstTraceDir,
      getEventCount: () => proxy.getTraceWriter().getEventCount(),
      finalizeTrace: () => proxy.getTraceWriter().finalize(),
      writeMeta: (meta) => proxy.getTraceWriter().writeMeta(meta),
      resetTrace: (dir) => proxy.resetTrace(dir),
    });
    exchangeHandler = () => splitter.onExchangeComplete();

    const proxyPort = await proxy.start();

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "sk-repro-dummy",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "stream test" }],
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      await res.text();

      const session = splitter.finalizeCurrentSession();
      expect(session).not.toBeNull();

      const reader = new TraceReader(session!.traceDir);
      const events = reader.readEvents();
      const responseEvents = events.filter(
        (e) => e.type === "model.response",
      );
      expect(responseEvents).toHaveLength(1);
      expect(responseEvents[0].data.streaming).toBe(true);

      const body = reader.resolveEventData(responseEvents[0])
        .body as Record<string, unknown>;
      expect(body.type).toBe("message");
      const content = body.content as Array<Record<string, unknown>>;
      expect(content[0].text).toBe("Streamed response!");
    } finally {
      splitter.destroy();
      await proxy.stop();
      await stub.stop();
    }
  }, 15000);
});
