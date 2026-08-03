import type { ThreadStateMigration } from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import type { CodingAgentSessionGuard } from "../sessions/session-guards";
import type {
  AssistantRenderer,
  AssistantRendererRegistrationOptions,
} from "../tui/assistant-renderer";
import type { TuiCommand } from "../tui/command";
import type { ToolRendererMap } from "../tui/tool-call-view";
import type { CodingAgentExtensionModelProvider } from "./types";

export const extensionCapabilityBrand: unique symbol = Symbol.for(
  "@minpeter/pss-coding-agent/extension/capability"
);

interface Capability<Kind extends string> {
  readonly kind: Kind;
  readonly [extensionCapabilityBrand]: true;
}

export interface AssistantRendererCapability
  extends Capability<"assistant-renderer"> {
  readonly fallback: boolean;
  readonly override: boolean;
  readonly renderer: AssistantRenderer;
}

export interface InstructionsCapability extends Capability<"instructions"> {
  readonly fragments: readonly string[];
}

export interface ToolsCapability extends Capability<"tools"> {
  readonly tools: ToolSet;
}

export interface CommandCapability extends Capability<"command"> {
  readonly command: TuiCommand;
}

export interface ThreadMigrationCapability
  extends Capability<"thread-migration"> {
  readonly migration: ThreadStateMigration;
}

export interface ToolRendererCapability extends Capability<"tool-renderer"> {
  readonly renderer: ToolRendererMap[string];
  readonly toolName: string;
}

export interface ModelProviderCapability extends Capability<"model-provider"> {
  readonly provider: CodingAgentExtensionModelProvider;
}

export interface SessionGuardCapability extends Capability<"session-guard"> {
  readonly guard: CodingAgentSessionGuard;
}

export interface ResourcesCapability extends Capability<"resources"> {
  /** Absolute directories containing `*.md` prompt templates. */
  readonly prompts: readonly string[];
  /** Absolute directories containing `<name>/SKILL.md` skill folders. */
  readonly skills: readonly string[];
}

export type ExtensionCapability =
  | AssistantRendererCapability
  | CommandCapability
  | InstructionsCapability
  | ModelProviderCapability
  | ResourcesCapability
  | SessionGuardCapability
  | ThreadMigrationCapability
  | ToolRendererCapability
  | ToolsCapability;

export function assistantRenderer(
  renderer: AssistantRenderer,
  options: AssistantRendererRegistrationOptions = {}
): AssistantRendererCapability {
  return Object.freeze({
    [extensionCapabilityBrand]: true as const,
    fallback: options.fallback === true,
    kind: "assistant-renderer",
    override: options.override === true,
    renderer,
  });
}

export function instructions(...fragments: string[]): InstructionsCapability {
  return Object.freeze({
    [extensionCapabilityBrand]: true as const,
    fragments: Object.freeze([...fragments]),
    kind: "instructions",
  });
}

export function tools(definitions: ToolSet): ToolsCapability {
  return Object.freeze({
    kind: "tools",
    tools: definitions,
  }) as ToolsCapability;
}

export function command(definition: TuiCommand): CommandCapability {
  return Object.freeze({
    command: definition,
    kind: "command",
  }) as CommandCapability;
}

export function modelProvider(
  provider: CodingAgentExtensionModelProvider
): ModelProviderCapability {
  return Object.freeze({
    kind: "model-provider",
    provider,
  }) as ModelProviderCapability;
}

export function sessionGuard(
  guard: CodingAgentSessionGuard
): SessionGuardCapability {
  return Object.freeze({
    guard,
    kind: "session-guard",
  }) as SessionGuardCapability;
}

export function resources(options: {
  readonly prompts?: readonly string[];
  readonly skills?: readonly string[];
}): ResourcesCapability {
  return Object.freeze({
    kind: "resources",
    prompts: Object.freeze([...(options.prompts ?? [])]),
    skills: Object.freeze([...(options.skills ?? [])]),
  }) as ResourcesCapability;
}

export function threadMigration(
  migration: ThreadStateMigration
): ThreadMigrationCapability {
  return Object.freeze({
    kind: "thread-migration",
    migration,
  }) as ThreadMigrationCapability;
}

export function toolRenderer(
  toolName: string,
  renderer: ToolRendererMap[string]
): ToolRendererCapability {
  return Object.freeze({
    kind: "tool-renderer",
    renderer,
    toolName,
  }) as ToolRendererCapability;
}
