import { type IncomingMessage, type ServerResponse } from "node:http";

export interface TraceEvent {
  seq: number;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface TraceMeta {
  id: string;
  command: string[];
  startTime: string;
  endTime?: string;
  eventCount: number;
  commit?: string;
  cwd?: string;
  env?: Record<string, string>;
  model?: string;
  auth?: "plan" | "credits";
}

export interface RecordedExchange {
  seq: number;
  normalizedHash: string;
  messageHashes: string[];
  request: AnthropicRequest;
  response: AnthropicResponse;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  system?: string | AnthropicSystemBlock[];
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock = Record<string, unknown> & {
  type: string;
};

export interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: string };
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface RedactionRule {
  name: string;
  test: (value: string) => boolean;
  type: "env" | "pattern" | "path";
}

export interface ProxyOptions {
  port?: number;
  upstream: string;
  mode: "record" | "replay";
  traceDir: string;
  traceId: string;
  onRequest?: (req: IncomingMessage) => void;
  onResponse?: (res: ServerResponse) => void;
  strict?: boolean;
}

export interface AssertionDef {
  type: "forbidden_path" | "no_repeat" | "max_calls" | "command";
  args: Record<string, unknown>;
}

export interface DaemonConfig {
  idle_split_seconds: number;
  retention_days: number;
  max_traces: number;
  max_disk_mb: number;
  port: number;
}

export interface AssertionResult {
  assertion: AssertionDef;
  passed: boolean;
  message: string;
}
