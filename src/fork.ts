import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { TraceReader } from "./trace.js";
import { createWorktree, removeWorktree } from "./worktree.js";
import type { TraceMeta, TraceEvent, AnthropicResponse } from "./types.js";

export interface ForkOptions {
  traceDir: string;
  forkAt: number;
  repoDir: string;
  strict?: boolean;
  upstream?: string;
}

export interface ForkResult {
  replayedSteps: number;
  worktreePath: string;
  warnings: string[];
  exitCode: number;
}

export interface ForkPlan {
  totalModelExchanges: number;
  replayCount: number;
  liveStartsAt: number;
  meta: TraceMeta;
  hasExternalState: boolean;
  hasAssertions: boolean;
  warnings: string[];
}

export function planFork(traceDir: string, forkAt: number): ForkPlan {
  const reader = new TraceReader(traceDir);
  const meta = reader.readMeta();
  const events = reader.readEvents();

  const modelExchanges = countModelExchanges(events);

  if (forkAt < 1 || forkAt > modelExchanges) {
    throw new Error(
      `--at must be between 1 and ${modelExchanges} (trace has ${modelExchanges} model exchanges)`,
    );
  }

  const replayCount = forkAt - 1;
  const warnings: string[] = [];

  const hasNetworkEvents = events.some(
    (e) => e.type !== "process.start" && e.type !== "process.exit" &&
           e.type !== "model.request" && e.type !== "model.response",
  );
  if (hasNetworkEvents) {
    warnings.push("external network state not captured — non-model events detected in trace");
  }

  if (!meta.commit) {
    warnings.push("no commit recorded — filesystem state may not match recording");
  }

  const hasAssertions = existsSync(join(traceDir, "assertions.json"));

  return {
    totalModelExchanges: modelExchanges,
    replayCount,
    liveStartsAt: forkAt,
    meta,
    hasExternalState: hasNetworkEvents,
    hasAssertions,
    warnings,
  };
}

function countModelExchanges(events: TraceEvent[]): number {
  return events.filter((e) => e.type === "model.request").length;
}

export class ForkProxy {
  private readonly traceReader: TraceReader;
  private readonly replayCount: number;
  private readonly upstream: string;
  private replaysServed = 0;
  private port = 0;
  private server: import("node:http").Server | null = null;

  constructor(
    traceDir: string,
    replayCount: number,
    upstream: string,
    private readonly cwd?: string | string[],
  ) {
    this.traceReader = new TraceReader(traceDir);
    this.replayCount = replayCount;
    this.upstream = upstream;
  }

  async start(port?: number): Promise<number> {
    const events = this.traceReader.readEvents();
    const requests = events.filter((e) => e.type === "model.request");
    const responses = events.filter((e) => e.type === "model.response");

    const replayResponses: Array<{
      hash: string;
      response: AnthropicResponse & { streaming: boolean };
      messageHashes: string[];
    }> = [];

    for (let i = 0; i < Math.min(this.replayCount, requests.length); i++) {
      const reqData = this.traceReader.resolveEventData(requests[i]);
      const resData = this.traceReader.resolveEventData(responses[i]);
      replayResponses.push({
        hash: reqData.normalizedHash as string,
        response: {
          ...(resData.body as AnthropicResponse),
          streaming: (resData.streaming as boolean) ?? false,
        },
        messageHashes: (reqData.messageHashes as string[]) ?? [],
      });
    }

    const { createServer } = await import("node:http");
    const { request: httpRequest } = await import("node:http");
    const { request: httpsRequest } = await import("node:https");
    const { rechunkToSSE } = await import("./sse.js");

    const upstreamUrl = new URL(this.upstream);

    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        if (req.method !== "POST" || !req.url?.includes("/v1/messages")) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }

          const isStreaming = parsed.stream === true;

          if (this.replaysServed < this.replayCount) {
            const recorded = replayResponses[this.replaysServed];
            this.replaysServed++;

            const response: AnthropicResponse = {
              id: recorded.response.id,
              type: recorded.response.type,
              role: recorded.response.role,
              content: recorded.response.content,
              model: recorded.response.model,
              stop_reason: recorded.response.stop_reason,
              stop_sequence: recorded.response.stop_sequence,
              usage: recorded.response.usage,
            };

            if (isStreaming) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              });
              const sseEvents = rechunkToSSE(response);
              for (const event of sseEvents) {
                res.write(event);
              }
              res.end();
            } else {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(response));
            }
            return;
          }

          const isHttps = upstreamUrl.protocol === "https:";
          const requestFn = isHttps ? httpsRequest : httpRequest;

          const headers: Record<string, string | string[] | undefined> = { ...req.headers };
          delete headers.host;
          delete (headers as Record<string, unknown>)["accept-encoding"];
          delete (headers as Record<string, unknown>)["content-length"];
          (headers as Record<string, string>).host = upstreamUrl.host;

          const proxyReq = requestFn({
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers: headers as Record<string, string>,
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(res);
          });

          proxyReq.on("error", (err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
          });

          proxyReq.end(body);
        });
      });

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

  getReplaysServed(): number {
    return this.replaysServed;
  }

  getPort(): number {
    return this.port;
  }
}

export async function executeFork(options: ForkOptions): Promise<ForkResult> {
  const plan = planFork(options.traceDir, options.forkAt);
  const { meta } = plan;
  const warnings = [...plan.warnings];

  const upstream = options.upstream ?? process.env.REPRO_UPSTREAM ?? "https://api.anthropic.com";

  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const hasCustomUpstream = !!options.upstream;

  if (plan.replayCount === 0 && !hasApiKey && !hasCustomUpstream) {
    throw new Error(
      "fork at step 1 requires a live API key (set ANTHROPIC_API_KEY) — there are no steps to replay",
    );
  }

  if (plan.replayCount < plan.totalModelExchanges && !hasApiKey && !hasCustomUpstream) {
    throw new Error(
      "fork requires a live API key for live execution (set ANTHROPIC_API_KEY)",
    );
  }

  let worktreeInfo: { path: string; commit: string } | null = null;

  try {
    worktreeInfo = createWorktree(options.repoDir, meta.commit);

    const proxy = new ForkProxy(
      options.traceDir,
      plan.replayCount,
      upstream,
      [worktreeInfo.path, ...(meta.cwd ? [meta.cwd] : [])],
    );

    const port = await proxy.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...(meta.env ?? {}),
      ANTHROPIC_BASE_URL: baseUrl,
      OPENAI_BASE_URL: baseUrl,
    };

    if (meta.auth === "plan") {
      delete childEnv.ANTHROPIC_API_KEY;
      delete childEnv.OPENAI_API_KEY;
    } else if (!childEnv.ANTHROPIC_API_KEY) {
      childEnv.ANTHROPIC_API_KEY = "sk-repro-fork-dummy";
    }

    const cmd = meta.command;

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(cmd[0], cmd.slice(1), {
        env: childEnv,
        stdio: "inherit",
        cwd: worktreeInfo!.path,
      });

      child.on("exit", (code) => resolve(code ?? 1));
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          console.error(`repro: error: agent binary '${cmd[0]}' not found on PATH`);
          resolve(127);
        } else {
          reject(err);
        }
      });
    });

    await proxy.stop();

    if (plan.hasExternalState) {
      warnings.push("external network state not captured");
    }

    return {
      replayedSteps: proxy.getReplaysServed(),
      worktreePath: worktreeInfo.path,
      warnings,
      exitCode,
    };
  } catch (err) {
    if (worktreeInfo) {
      removeWorktree(options.repoDir, worktreeInfo.path);
    }
    throw err;
  }
}
