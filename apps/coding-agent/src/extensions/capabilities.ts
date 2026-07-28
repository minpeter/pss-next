import type { ThreadStateMigration } from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import type { CodingAgentSessionGuard } from "../sessions/session-guards";
import type { TuiCommand } from "../tui/command";
import type { ToolRendererMap } from "../tui/tool-call-view";
import type { CodingAgentExtensionModelProvider } from "./types";

declare const capabilityBrand: unique symbol;

interface Capability<Kind extends string> {
  readonly kind: Kind;
  readonly [capabilityBrand]: true;
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
  | CommandCapability
  | InstructionsCapability
  | ModelProviderCapability
  | ResourcesCapability
  | SessionGuardCapability
  | ThreadMigrationCapability
  | ToolRendererCapability
  | ToolsCapability;

export function instructions(...fragments: string[]): InstructionsCapability {
  return Object.freeze({
    fragments: Object.freeze([...fragments]),
    kind: "instructions",
  }) as InstructionsCapability;
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
