import type {
  Agent,
  AgentEvent,
  AgentHooks,
  AgentInstrumentationContext,
  ThreadStateMigration,
} from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import type { TuiCommand } from "../tui/command";
import type { ToolRendererMap } from "../tui/tool-call-view";
import type { ExtensionCapability } from "./capabilities";

export type CodingAgentExtensionMode = "exec" | "tui";

export interface CodingAgentExtensionSetupContext {
  readonly signal: AbortSignal;
}

export interface CodingAgentExtensionActivationContext {
  readonly agent: Agent;
  readonly mode: CodingAgentExtensionMode;
  readonly signal: AbortSignal;
}

export type CodingAgentExtensionCleanup = () => Promise<void> | void;

export type CodingAgentExtensionActivationHandler = (
  context: CodingAgentExtensionActivationContext
) =>
  | CodingAgentExtensionCleanup
  | Promise<CodingAgentExtensionCleanup | undefined>
  | undefined;

export interface CodingAgentExtensionEventContext
  extends AgentInstrumentationContext {
  readonly signal: AbortSignal;
  readonly stream: boolean;
}

export type CodingAgentExtensionEventHandler<Type extends AgentEvent["type"]> =
  (
    event: Extract<AgentEvent, { readonly type: Type }>,
    context: CodingAgentExtensionEventContext
  ) => Promise<void> | void;

export interface CodingAgentExtensionRegistry {
  readonly commands: {
    register(command: TuiCommand): void;
  };
  readonly instructions: {
    append(fragment: string): void;
  };
  on<Type extends AgentEvent["type"]>(
    type: Type,
    handler: CodingAgentExtensionEventHandler<Type>
  ): void;
  provide(capability: ExtensionCapability): void;
  readonly runtime: {
    use(hooks: AgentHooks): void;
  };
  readonly storage: {
    registerThreadMigration(migration: ThreadStateMigration): void;
  };
  readonly tools: {
    register(name: string, tool: ToolSet[string]): void;
  };
  readonly tui: {
    registerToolRenderer(
      toolName: string,
      renderer: ToolRendererMap[string]
    ): void;
  };
  use(hooks: AgentHooks): void;
}

export interface CodingAgentExtensionApi {
  on<Type extends AgentEvent["type"]>(
    type: Type,
    handler: CodingAgentExtensionEventHandler<Type>
  ): void;
  on(type: "activate", handler: CodingAgentExtensionActivationHandler): void;
  provide(capability: ExtensionCapability): void;
  use(hooks: AgentHooks): void;
}

export type ExtensionAPI = CodingAgentExtensionApi;

export type CodingAgentExtensionFactory = (
  pss: CodingAgentExtensionApi
) => Promise<void> | void;

export interface CodingAgentExtension {
  readonly activate?: CodingAgentExtensionActivationHandler;
  readonly configure: (
    registry: CodingAgentExtensionRegistry,
    context: CodingAgentExtensionSetupContext
  ) => Promise<void> | void;
  readonly id: string;
}

export interface CodingAgentExtensionModule {
  readonly default: CodingAgentExtensionFactory;
  readonly id: string;
}

export type CodingAgentExtensionInput =
  | CodingAgentExtension
  | CodingAgentExtensionModule;

export interface CodingAgentExtensionHostOptions {
  readonly timeoutMs?: number;
}

export function defineCodingAgentExtension(
  extension: CodingAgentExtension
): CodingAgentExtension {
  return extension;
}
