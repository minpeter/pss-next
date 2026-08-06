import type { ThreadStateMigration } from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import type { CodingAgentSessionGuard } from "../sessions/session-guards";
import type {
  AssistantRenderer,
  AssistantRendererMode,
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
  readonly mode: AssistantRendererMode;
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
  const mode = resolveAssistantRendererMode(options);
  return capability({
    fallback: mode === "fallback",
    kind: "assistant-renderer",
    mode,
    override: mode === "override",
    renderer,
  });
}

export function instructions(...fragments: string[]): InstructionsCapability {
  return capability({
    fragments: Object.freeze([...fragments]),
    kind: "instructions",
  });
}

export function tools(definitions: ToolSet): ToolsCapability {
  return capability({ kind: "tools", tools: definitions });
}

export function command(definition: TuiCommand): CommandCapability {
  return capability({ command: definition, kind: "command" });
}

export function modelProvider(
  provider: CodingAgentExtensionModelProvider
): ModelProviderCapability {
  return capability({ kind: "model-provider", provider });
}

export function sessionGuard(
  guard: CodingAgentSessionGuard
): SessionGuardCapability {
  return capability({ guard, kind: "session-guard" });
}

export function resources(options: {
  readonly prompts?: readonly string[];
  readonly skills?: readonly string[];
}): ResourcesCapability {
  return capability({
    kind: "resources",
    prompts: Object.freeze([...(options.prompts ?? [])]),
    skills: Object.freeze([...(options.skills ?? [])]),
  });
}

export function threadMigration(
  migration: ThreadStateMigration
): ThreadMigrationCapability {
  return capability({ kind: "thread-migration", migration });
}

export function toolRenderer(
  toolName: string,
  renderer: ToolRendererMap[string]
): ToolRendererCapability {
  return capability({ kind: "tool-renderer", renderer, toolName });
}

function capability<Value extends { readonly kind: string }>(
  value: Value
): Value & Capability<Value["kind"]> {
  return Object.freeze({
    ...value,
    [extensionCapabilityBrand]: true as const,
  });
}

function resolveAssistantRendererMode(
  options: AssistantRendererRegistrationOptions
): AssistantRendererMode {
  if ("mode" in options && options.mode !== undefined) {
    return options.mode;
  }
  if ("fallback" in options && options.fallback === true) {
    return "fallback";
  }
  if ("override" in options && options.override === true) {
    return "override";
  }
  return "exclusive";
}
