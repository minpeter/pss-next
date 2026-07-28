import type {
  Agent,
  AgentEvent,
  AgentHooks,
  AgentInstrumentationContext,
  ThreadStateMigration,
} from "@minpeter/pss-runtime";
import type { LanguageModel, ToolSet } from "ai";
import type {
  AssistantRenderer,
  AssistantRendererRegistrationOptions,
} from "../tui/assistant-renderer";
import type { TuiCommand } from "../tui/command";
import type { ToolRendererMap } from "../tui/tool-call-view";
import type { ExtensionCapability } from "./capabilities";

export type CodingAgentExtensionMode = "exec" | "tui";

export type ExtensionJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly ExtensionJsonValue[]
  | { readonly [key: string]: ExtensionJsonValue };

export interface CodingAgentExtensionLogger {
  debug(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface CodingAgentExtensionUi {
  confirm(message: string): Promise<boolean>;
  input(options: {
    readonly initialValue?: string;
    readonly label: string;
  }): Promise<string | undefined>;
  notify(message: string): void;
  select(options: {
    readonly label: string;
    readonly options: readonly {
      readonly description?: string;
      readonly label: string;
      readonly value: string;
    }[];
  }): Promise<string | undefined>;
  status(message: string): () => void;
}

export interface CodingAgentExtensionExecResult {
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface CodingAgentExtensionExec {
  run(options: {
    readonly args: readonly string[];
    readonly command: string;
    readonly cwd?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<CodingAgentExtensionExecResult>;
}

export interface CodingAgentExtensionModelSelector {
  readonly id: string;
  readonly provider: string;
}

export interface CodingAgentExtensionAgents {
  create(options: {
    readonly instructions: string;
    readonly model?: CodingAgentExtensionModelSelector;
    readonly tools?: ToolSet;
  }): Promise<Agent>;
}

export interface CodingAgentExtensionState {
  clear(): Promise<void>;
  get(): Promise<ExtensionJsonValue | undefined>;
  set(value: ExtensionJsonValue): Promise<void>;
  update(
    updater: (
      current: ExtensionJsonValue | undefined
    ) => ExtensionJsonValue | Promise<ExtensionJsonValue>
  ): Promise<ExtensionJsonValue>;
}

/**
 * Inter-extension publish/subscribe events plus host observations.
 *
 * Host-originated events use reserved namespaces (`host:`, `provider:`)
 * that extensions can subscribe to but never publish.
 */
export interface CodingAgentExtensionEvents {
  emit(type: string, payload?: ExtensionJsonValue): void;
  on(
    type: string,
    handler: (payload: ExtensionJsonValue | undefined) => Promise<void> | void
  ): () => void;
}

export interface CodingAgentExtensionServices {
  readonly agents: CodingAgentExtensionAgents;
  readonly config: Readonly<Record<string, ExtensionJsonValue>>;
  readonly events: CodingAgentExtensionEvents;
  readonly exec: CodingAgentExtensionExec;
  readonly logger: CodingAgentExtensionLogger;
  readonly state: CodingAgentExtensionState;
  readonly ui: CodingAgentExtensionUi;
}

export interface CodingAgentExtensionModelProvider {
  readonly create: (modelId: string) => LanguageModel;
  readonly id: string;
  readonly models: readonly string[];
}

export interface CodingAgentExtensionSetupContext {
  readonly signal: AbortSignal;
}

export interface CodingAgentExtensionActivationContext {
  readonly agent: Agent;
  readonly mode: CodingAgentExtensionMode;
  readonly services: CodingAgentExtensionServices;
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
  readonly services: CodingAgentExtensionServices;
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
    registerAssistantRenderer(
      renderer: AssistantRenderer,
      options?: AssistantRendererRegistrationOptions
    ): void;
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
  readonly config?: Readonly<Record<string, ExtensionJsonValue>>;
  readonly configure: (
    registry: CodingAgentExtensionRegistry,
    context: CodingAgentExtensionSetupContext
  ) => Promise<void> | void;
  readonly id: string;
}

export interface CodingAgentExtensionModule {
  readonly config?: Readonly<Record<string, ExtensionJsonValue>>;
  readonly default: CodingAgentExtensionFactory;
  readonly id: string;
}

export type CodingAgentExtensionInput =
  | CodingAgentExtension
  | CodingAgentExtensionModule;

export interface CodingAgentExtensionHostOptions {
  readonly config?: Readonly<
    Record<string, Readonly<Record<string, ExtensionJsonValue>>>
  >;
  readonly dataRoot?: string;
  readonly model?: LanguageModel;
  readonly timeoutMs?: number;
  readonly workspace?: string;
}

export function defineCodingAgentExtension(
  extension: CodingAgentExtension
): CodingAgentExtension {
  return extension;
}
