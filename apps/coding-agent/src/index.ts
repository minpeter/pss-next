// biome-ignore-all lint/performance/noBarrelFile: Public package entrypoint required by package exports.

export {
  type CreateCodingAgentOptions,
  createCodingAgent,
} from "./coding-agent";
export {
  type CodingAgentRuntimeEnv,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_MODEL_ID,
  readOpenAICompatibleModelEnv,
} from "./env";
export {
  type CodingAgentExecResult,
  type RunCodingAgentExecOptions,
  runCodingAgentExec,
} from "./exec";
export { formatExecUsage, parseExecArguments, runExecCli } from "./exec-cli";
export * from "./extensions";
export { CODING_AGENT_INSTRUCTIONS } from "./instructions";
export type {
  CreateOpenAICompatibleModelFromDotenvOptions,
  CreateOpenAICompatibleModelFromEnvOptions,
} from "./model";
export { createCodingLanguageModel } from "./model";
export type { CodingAgentThreadConfig } from "./thread-config";
export { resolveCodingAgentThreadConfig } from "./thread-config";
export type {
  ThreadInspectionCompaction,
  ThreadInspectionReport,
} from "./thread-inspect";
export {
  formatThreadInspectionReport,
  inspectCodingAgentThread,
  storageFileForThread,
} from "./thread-inspect";
export type {
  CodingAgentOpenSearchClient,
  CodingAgentToolSet,
  CreateCodingAgentToolsOptions,
  WebFetchInput,
  WebSearchInput,
  WebToolsAvailability,
} from "./tools";
export {
  CodingAgentToolAbortError,
  CodingAgentToolsConfigError,
  CodingAgentWebToolsUnavailableError,
  createCodingAgentTools,
  WEB_TOOLS_DISABLED_MESSAGE,
} from "./tools";
export { type StartTuiOptions, startTui } from "./tui/app";
export {
  type CreateWorkspaceToolsOptions,
  createWorkspaceTools,
} from "./workspace-tools";
