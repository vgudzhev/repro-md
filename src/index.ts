export const VERSION = "0.1.0";

export { RecordingProxy, ReplayProxy } from "./proxy.js";
export { TraceWriter, TraceReader } from "./trace.js";
export { hashRequest, computeMessageHashes, normalizeRequest } from "./normalize.js";
export {
  redactSecrets,
  redactEnvValues,
  redactString,
  redactJsonDeep,
  redactAuthHeader,
  buildEnvRedactions,
  matchesPathDenylist,
} from "./redact.js";
export { reassembleSSE, rechunkToSSE } from "./sse.js";
export { generateTraceId } from "./id.js";
export { evaluateAssertions } from "./assertions.js";
export { scaffoldRepro, readManifest, writeManifest, addEntry } from "./manifest.js";
export { createWorktree, removeWorktree } from "./worktree.js";
export { alignTraces, explainDivergence } from "./diff.js";
export { ddmin, minimize, StochasticOracle, BudgetExhaustedError } from "./minimize.js";
export type { Oracle, OracleOptions, MinimizeResult } from "./minimize.js";
export { StubUpstream } from "./test-fixtures/stub-upstream.js";
export { SessionSplitter } from "./session-splitter.js";
export type { CompletedSession, SessionSplitterOptions } from "./session-splitter.js";
export {
  loadDaemonConfig,
  listDaemonTraces,
  pruneTraces,
  getDaemonDiskUsage,
  DEFAULT_DAEMON_CONFIG,
} from "./retention.js";
export type { TraceInfo } from "./retention.js";
export {
  startDaemon,
  stopDaemon,
  daemonStatus,
  daemonRun,
  getReproHome,
  getTracesDir,
} from "./daemon.js";
export type { DaemonConfig } from "./types.js";
export {
  captureSnapshot,
  formatSnapshot,
  writeSnapshot,
  readSnapshot,
  SNAPSHOT_FORMAT_VERSION,
} from "./snapshot.js";
export type { EnvironmentSnapshot, SnapshotOptions } from "./snapshot.js";
