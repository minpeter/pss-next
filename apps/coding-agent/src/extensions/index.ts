// biome-ignore-all lint/performance/noBarrelFile: public extension package entrypoint
export type {
  ThreadMigrationContext,
  ThreadMigrationSnapshot,
  ThreadStateMigration,
} from "@minpeter/pss-runtime";
export type {
  TuiCommand,
  TuiCommandAction,
  TuiCommandResult,
} from "../tui/command";
export type {
  BaseToolCallView,
  ToolRendererMap,
} from "../tui/tool-call-view";
export type {
  CommandCapability,
  ExtensionCapability,
  InstructionsCapability,
  ModelProviderCapability,
  ThreadMigrationCapability,
  ToolRendererCapability,
  ToolsCapability,
} from "./capabilities";
export {
  command,
  instructions,
  modelProvider,
  threadMigration,
  toolRenderer,
  tools,
} from "./capabilities";
export { composeAgentHooks } from "./compose-hooks";
export {
  CodingAgentExtensionError,
  type CodingAgentExtensionPhase,
} from "./error";
export {
  CodingAgentExtensionHost,
  createCodingAgentExtensionHost,
} from "./host";
export { loadConfiguredCodingAgentExtensions } from "./manager/loader";
export type {
  ExtensionScope,
  ExtensionSettingsEntry,
  LoadedConfiguredExtensions,
} from "./manager/types";
export {
  type CodingAgentExtension,
  type CodingAgentExtensionActivationContext,
  type CodingAgentExtensionActivationHandler,
  type CodingAgentExtensionAgents,
  type CodingAgentExtensionApi,
  type CodingAgentExtensionCleanup,
  type CodingAgentExtensionEventContext,
  type CodingAgentExtensionEventHandler,
  type CodingAgentExtensionExec,
  type CodingAgentExtensionExecResult,
  type CodingAgentExtensionFactory,
  type CodingAgentExtensionHostOptions,
  type CodingAgentExtensionInput,
  type CodingAgentExtensionLogger,
  type CodingAgentExtensionMode,
  type CodingAgentExtensionModelProvider,
  type CodingAgentExtensionModelSelector,
  type CodingAgentExtensionModule,
  type CodingAgentExtensionRegistry,
  type CodingAgentExtensionServices,
  type CodingAgentExtensionSetupContext,
  type CodingAgentExtensionState,
  type CodingAgentExtensionUi,
  defineCodingAgentExtension,
  type ExtensionAPI,
  type ExtensionJsonValue,
} from "./types";
