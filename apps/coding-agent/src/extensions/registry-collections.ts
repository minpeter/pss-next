import type { ThreadStateMigration } from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import type { TuiCommand } from "../tui/command";
import type { ToolRendererMap } from "../tui/tool-call-view";
import type { RegisteredAgentHooks } from "./compose-hooks";
import type { RegisteredCodingAgentExtensionEvent } from "./events";
import {
  assertNoCommandConflicts,
  assertNoKeyConflicts,
  recordCommandOwners,
} from "./registry-conflicts";
import type { CodingAgentExtensionModelProvider } from "./types";

export interface ExtensionRegistryCollections {
  readonly commands: TuiCommand[];
  readonly events: RegisteredCodingAgentExtensionEvent[];
  readonly hooks: RegisteredAgentHooks[];
  readonly instructions: string[];
  readonly migrations: ThreadStateMigration[];
  readonly modelProviders: Map<string, CodingAgentExtensionModelProvider>;
  readonly owners: ExtensionContributionOwners;
  readonly renderers: ToolRendererMap;
  readonly resourceRoots: { prompts: string[]; skills: string[] };
  readonly tools: ToolSet;
}

interface ExtensionContributionOwners {
  readonly commands: Map<string, string>;
  readonly migrations: Map<string, string>;
  readonly modelProviders: Map<string, string>;
  readonly renderers: Map<string, string>;
  readonly tools: Map<string, string>;
}

export function createExtensionRegistryCollections(): ExtensionRegistryCollections {
  return {
    commands: [],
    events: [],
    hooks: [],
    instructions: [],
    migrations: [],
    modelProviders: new Map(),
    owners: {
      commands: new Map(),
      migrations: new Map(),
      modelProviders: new Map(),
      renderers: new Map(),
      tools: new Map(),
    },
    renderers: Object.create(null) as ToolRendererMap,
    resourceRoots: { prompts: [], skills: [] },
    tools: Object.create(null) as ToolSet,
  };
}

export function commitExtensionRegistryCollections(
  target: ExtensionRegistryCollections,
  staged: ExtensionRegistryCollections,
  extensionId: string
): void {
  assertNoCommandConflicts(
    target.commands,
    staged.commands,
    target.owners.commands,
    extensionId
  );
  assertNoKeyConflicts(
    target.tools,
    staged.tools,
    target.owners.tools,
    extensionId,
    "Tool"
  );
  assertNoKeyConflicts(
    target.renderers,
    staged.renderers,
    target.owners.renderers,
    extensionId,
    "Tool renderer"
  );
  for (const migration of staged.migrations) {
    if (target.migrations.some(({ id }) => id === migration.id)) {
      const existingOwner =
        target.owners.migrations.get(migration.id) ?? extensionId;
      throw new Error(
        `Thread migration "${migration.id}" from extension "${extensionId}" conflicts with extension "${existingOwner}"`
      );
    }
  }
  for (const [id] of staged.modelProviders) {
    const existingOwner = target.owners.modelProviders.get(id);
    if (existingOwner !== undefined) {
      throw new Error(
        `Model provider "${id}" from extension "${extensionId}" conflicts with extension "${existingOwner}"`
      );
    }
  }
  target.commands.push(...staged.commands);
  target.events.push(...staged.events);
  target.hooks.push(...staged.hooks);
  target.instructions.push(...staged.instructions);
  target.migrations.push(...staged.migrations);
  target.resourceRoots.prompts.push(...staged.resourceRoots.prompts);
  target.resourceRoots.skills.push(...staged.resourceRoots.skills);
  for (const [id, provider] of staged.modelProviders) {
    target.modelProviders.set(id, provider);
    target.owners.modelProviders.set(id, extensionId);
  }
  Object.assign(target.renderers, staged.renderers);
  Object.assign(target.tools, staged.tools);
  recordCommandOwners(target.owners.commands, staged.commands, extensionId);
  for (const migration of staged.migrations) {
    target.owners.migrations.set(migration.id, extensionId);
  }
  for (const name of Object.keys(staged.renderers)) {
    target.owners.renderers.set(name, extensionId);
  }
  for (const name of Object.keys(staged.tools)) {
    target.owners.tools.set(name, extensionId);
  }
}
