import type { ThreadStateMigration } from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
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

export type ExtensionCapability =
  | CommandCapability
  | InstructionsCapability
  | ModelProviderCapability
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
