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
  exportBundle,
  importBundle,
  readBundle,
  validateBundle,
  checkBundleSecurity,
  stableStringify,
  BUNDLE_FORMAT_VERSION,
  BUNDLE_GENERATOR,
} from "./bundle.js";
export type {
  Bundle,
  SecurityFinding,
  SecurityCheckResult,
  ExportResult,
  ImportResult,
  BundleValidationError,
} from "./bundle.js";
export {
  verify,
  runAllChecks,
  computeVerdict,
  formatVerifyResult,
  formatVerifyJson,
  verifyTraceIntegrity,
  verifyMetaIntegrity,
  verifyRequiredBlobs,
  verifyGitCommit,
  verifyRepositoryState,
  verifyPlatform,
  verifyArchitecture,
  verifyRuntimeVersion,
  verifyPackageManager,
  verifyLockfileHash,
  verifyRequiredFiles,
  verifyAgentBinary,
  verifyAgentVersion,
  verifyModelCompatibility,
  verifyReplayPrerequisites,
  verifyWorktreePrerequisites,
} from "./verify.js";
export type {
  CheckStatus,
  VerifyCheck,
  VerifyResult,
  VerifyOptions,
} from "./verify.js";
