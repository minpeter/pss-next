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
  ThreadMigrationCapability,
  ToolRendererCapability,
  ToolsCapability,
} from "./capabilities";
export {
  command,
  instructions,
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
  type CodingAgentExtensionApi,
  type CodingAgentExtensionCleanup,
  type CodingAgentExtensionEventContext,
  type CodingAgentExtensionEventHandler,
  type CodingAgentExtensionFactory,
  type CodingAgentExtensionHostOptions,
  type CodingAgentExtensionInput,
  type CodingAgentExtensionMode,
  type CodingAgentExtensionModule,
  type CodingAgentExtensionRegistry,
  type CodingAgentExtensionSetupContext,
  defineCodingAgentExtension,
  type ExtensionAPI,
} from "./types";
