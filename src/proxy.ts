import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { TraceWriter } from "./trace.js";
import { TraceReader } from "./trace.js";
import { hashRequest, computeMessageHashes, normalizeRequest } from "./normalize.js";
import { writeFileSync } from "node:fs";
import {
  buildEnvRedactions,
  redactJsonDeep,
  redactAuthHeader,
  type RedactionConfig,
} from "./redact.js";
import { reassembleSSE, rechunkToSSE } from "./sse.js";
import type { AnthropicRequest, AnthropicResponse } from "./types.js";

export interface RecordingProxyOptions {
  upstream: string;
  traceDir: string;
  traceId: string;
  port?: number;
  blobThreshold?: number;
  redactionConfig?: RedactionConfig;
  env?: Record<string, string | undefined>;
  cwd?: string;
  onExchangeComplete?: () => void;
}

export interface ReplayProxyOptions {
  traceDir: string;
  port?: number;
  strict?: boolean;
  cwd?: string | string[];
}

export class RecordingProxy {
  private server: Server | null = null;
  private readonly upstream: URL;
  private traceWriter: TraceWriter;
  private readonly envRedactions: Array<{ value: string; marker: string }>;
  private readonly redactionConfig: RedactionConfig;
  private readonly cwd: string | undefined;
  private readonly blobThreshold: number;
  private readonly onExchangeComplete?: () => void;
  private seq = 0;
  private port = 0;

  constructor(options: RecordingProxyOptions) {
    this.upstream = new URL(options.upstream);
    this.cwd = options.cwd;
    this.blobThreshold = options.blobThreshold ?? 10 * 1024;
    this.traceWriter = new TraceWriter(
      options.traceDir,
      this.blobThreshold,
    );
    this.envRedactions = buildEnvRedactions(
      (options.env ?? process.env) as Record<string, string | undefined>,
      options.redactionConfig?.allowedEnvVars,
    );
    this.redactionConfig = options.redactionConfig ?? {};
    this.onExchangeComplete = options.onExchangeComplete;
  }

  async start(port?: number): Promise<number> {
    this.traceWriter.init();

    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(port ?? 0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (typeof addr === "object" && addr) {
          this.port = addr.port;
        }
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    this.traceWriter.finalize();
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getTraceWriter(): TraceWriter {
    return this.traceWriter;
  }

  getPort(): number {
    return this.port;
  }

  resetTrace(newTraceDir: string): void {
    this.traceWriter = new TraceWriter(newTraceDir, this.blobThreshold);
    this.traceWriter.init();
    this.seq = 0;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (
      req.method !== "POST" ||
      !req.url?.includes("/v1/messages")
    ) {
      this.passthrough(req, res);
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      this.handleMessagesRequest(req, res, body);
    });
  }

  private handleMessagesRequest(
    req: IncomingMessage,
    res: ServerResponse,
    body: string,
  ): void {
    let parsed: AnthropicRequest;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const isStreaming = parsed.stream === true;
    const currentSeq = this.seq++;

    const normalizedHash = hashRequest(parsed, this.cwd);
    const messageHashes = computeMessageHashes(parsed.messages ?? [], this.cwd);

    const redactedRequest = redactJsonDeep(
      parsed,
      this.envRedactions,
      this.redactionConfig,
    ) as AnthropicRequest;

    this.traceWriter.append("model.request", {
      seq: currentSeq,
      normalizedHash,
      messageHashes,
      body: redactedRequest,
      headers: redactAuthHeader(
        req.headers as Record<string, string | string[] | undefined>,
      ),
    });

    const upstreamReq = this.buildUpstreamRequest(req, body);

    upstreamReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
    });

    upstreamReq.on("response", (upstreamRes) => {
      if (isStreaming) {
        this.handleStreamingResponse(upstreamRes, res, currentSeq);
      } else {
        this.handleJsonResponse(upstreamRes, res, currentSeq);
      }
    });

    upstreamReq.end(body);
  }

  private buildUpstreamRequest(
    req: IncomingMessage,
    _body: string,
  ): ReturnType<typeof httpRequest> {
    const isHttps = this.upstream.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;

    const headers = { ...req.headers };
    delete headers.host;
    delete headers["accept-encoding"];
    delete headers["content-length"];
    headers.host = this.upstream.host;

    return requestFn({
      hostname: this.upstream.hostname,
      port: this.upstream.port || (isHttps ? 443 : 80),
      path: req.url,
      method: req.method,
      headers,
    });
  }

  private handleJsonResponse(
    upstreamRes: IncomingMessage,
    clientRes: ServerResponse,
    seq: number,
  ): void {
    let body = "";
    upstreamRes.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });

    upstreamRes.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body;
      }

      const redacted = redactJsonDeep(
        parsed,
        this.envRedactions,
        this.redactionConfig,
      );

      this.traceWriter.append("model.response", {
        seq,
        body: redacted,
        streaming: false,
      });
      this.onExchangeComplete?.();

      clientRes.writeHead(upstreamRes.statusCode ?? 200, {
        "Content-Type": "application/json",
      });
      clientRes.end(body);
    });
  }

  private handleStreamingResponse(
    upstreamRes: IncomingMessage,
    clientRes: ServerResponse,
    seq: number,
  ): void {
    const chunks: string[] = [];

    clientRes.writeHead(upstreamRes.statusCode ?? 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    upstreamRes.on("data", (chunk: Buffer) => {
      chunks.push(chunk.toString());
      clientRes.write(chunk);
    });

    upstreamRes.on("end", () => {
      const reassembled = reassembleSSE(chunks);
      const redacted = redactJsonDeep(
        reassembled,
        this.envRedactions,
        this.redactionConfig,
      ) as AnthropicResponse;

      this.traceWriter.append("model.response", {
        seq,
        body: redacted,
        streaming: true,
      });
      this.onExchangeComplete?.();

      clientRes.end();
    });
  }

  private passthrough(req: IncomingMessage, res: ServerResponse): void {
    const isHttps = this.upstream.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;

    const headers = { ...req.headers };
    delete headers.host;
    headers.host = this.upstream.host;

    const proxyReq = requestFn(
      {
        hostname: this.upstream.hostname,
        port: this.upstream.port || (isHttps ? 443 : 80),
        path: req.url,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(
          proxyRes.statusCode ?? 200,
          proxyRes.headers,
        );
        proxyRes.pipe(res);
      },
    );

    req.pipe(proxyReq);
  }
}

export class ReplayProxy {
  private server: Server | null = null;
  private readonly traceReader: TraceReader;
  private readonly strict: boolean;
  private readonly responseIndex: Map<string, AnthropicResponse & { streaming: boolean }> =
    new Map();
  private readonly positionalResponses: Array<
    AnthropicResponse & { streaming: boolean }
  > = [];
  private requestCount = 0;
  private port = 0;
  private divergences: Array<{
    seq: number;
    expected: string;
    actual: string;
    messageIndex?: number;
  }> = [];

  private readonly cwd: string | string[] | undefined;

  constructor(options: ReplayProxyOptions) {
    this.traceReader = new TraceReader(options.traceDir);
    this.strict = options.strict ?? true;
    this.cwd = options.cwd;
  }

  async start(port?: number): Promise<number> {
    this.loadTrace();

    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(port ?? 0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (typeof addr === "object" && addr) {
          this.port = addr.port;
        }
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getPort(): number {
    return this.port;
  }

  getDivergences(): Array<{
    seq: number;
    expected: string;
    actual: string;
    messageIndex?: number;
  }> {
    return this.divergences;
  }

  private readonly recordedMessageHashes: string[][] = [];

  private loadTrace(): void {
    const events = this.traceReader.readEvents();

    const requests = events.filter((e) => e.type === "model.request");
    const responses = events.filter((e) => e.type === "model.response");

    for (let i = 0; i < requests.length; i++) {
      const reqEvent = requests[i];
      const resEvent = responses[i];
      if (!resEvent) continue;

      const reqData = this.traceReader.resolveEventData(reqEvent);
      const resData = this.traceReader.resolveEventData(resEvent);
      const hash = reqData.normalizedHash as string;
      const body = resData.body as AnthropicResponse;
      const streaming = (resData.streaming as boolean) ?? false;
      const messageHashes = (reqData.messageHashes as string[]) ?? [];

      this.responseIndex.set(hash, { ...body, streaming });
      this.positionalResponses.push({ ...body, streaming });
      this.recordedMessageHashes.push(messageHashes);
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (
      req.method !== "POST" ||
      !req.url?.includes("/v1/messages")
    ) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      this.handleReplayRequest(req, res, body);
    });
  }

  private handleReplayRequest(
    _req: IncomingMessage,
    res: ServerResponse,
    body: string,
  ): void {
    let parsed: AnthropicRequest;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const isStreaming = parsed.stream === true;
    const currentSeq = this.requestCount++;
    const hash = hashRequest(parsed, this.cwd);

    if (process.env.REPRO_DEBUG) {
      const normalized = normalizeRequest(parsed, this.cwd);
      writeFileSync(`/tmp/repro-debug-replay-seq${currentSeq}.json`, JSON.stringify(normalized, null, 2));
      writeFileSync(`/tmp/repro-debug-replay-hash${currentSeq}.txt`, `hash=${hash}\ncwd=${this.cwd}\n`);
    }

    const hashMatch = this.responseIndex.get(hash);
    if (hashMatch) {
      this.serveResponse(res, hashMatch, isStreaming);
      return;
    }

    if (this.strict) {
      const incomingHashes = computeMessageHashes(parsed.messages ?? [], this.cwd);
      const closestRecorded = this.findClosestChain(incomingHashes);
      const messageIndex = closestRecorded
        ? this.findDivergingIndex(closestRecorded, incomingHashes)
        : undefined;

      this.divergences.push({
        seq: currentSeq,
        expected: `hash match expected`,
        actual: `hash ${hash} not found`,
        messageIndex,
      });

      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "replay_diverged",
          message: `Request ${currentSeq} hash mismatch at message index ${messageIndex ?? "unknown"}. Agent has diverged from recording.`,
          seq: currentSeq,
          hash,
          messageIndex,
        }),
      );
      return;
    }

    if (currentSeq < this.positionalResponses.length) {
      this.divergences.push({
        seq: currentSeq,
        expected: `hash match`,
        actual: `positional fallback (hash ${hash} not found)`,
      });
      this.serveResponse(
        res,
        this.positionalResponses[currentSeq],
        isStreaming,
      );
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "no_more_responses",
          message: `No response available for request ${currentSeq}`,
        }),
      );
    }
  }

  private findClosestChain(incoming: string[]): string[] | null {
    let best: string[] | null = null;
    let bestOverlap = 0;
    for (const chain of this.recordedMessageHashes) {
      let overlap = 0;
      const limit = Math.min(chain.length, incoming.length);
      for (let i = 0; i < limit; i++) {
        if (chain[i] === incoming[i]) overlap++;
        else break;
      }
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = chain;
      }
    }
    return best;
  }

  private findDivergingIndex(
    recorded: string[],
    incoming: string[],
  ): number {
    const limit = Math.max(recorded.length, incoming.length);
    for (let i = 0; i < limit; i++) {
      if (recorded[i] !== incoming[i]) return i;
    }
    return limit;
  }

  private serveResponse(
    res: ServerResponse,
    recorded: AnthropicResponse & { streaming: boolean },
    clientWantsStreaming: boolean,
  ): void {
    const response: AnthropicResponse = {
      id: recorded.id,
      type: recorded.type,
      role: recorded.role,
      content: recorded.content,
      model: recorded.model,
      stop_reason: recorded.stop_reason,
      stop_sequence: recorded.stop_sequence,
      usage: recorded.usage,
    };

    if (clientWantsStreaming) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const sseEvents = rechunkToSSE(response as AnthropicResponse);
      for (const event of sseEvents) {
        res.write(event);
      }
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    }
  }
}
