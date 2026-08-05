import type { ThreadStateMigration } from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import type { RegisteredSessionGuard } from "../sessions/session-guards";
import type { AssistantRenderer } from "../tui/assistant-renderer";
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

export interface RegisteredAssistantRenderer {
  readonly fallback: boolean;
  readonly override: boolean;
  readonly renderer: AssistantRenderer;
}

export interface ExtensionRegistryCollections {
  /** Exclusive or override renderer; mutually exclusive with the chain. */
  assistantRenderer?: RegisteredAssistantRenderer;
  /** Fallback renderers in registration order; the last entry is outermost. */
  readonly assistantRendererChain: RegisteredAssistantRenderer[];
  readonly commands: TuiCommand[];
  readonly events: RegisteredCodingAgentExtensionEvent[];
  readonly hooks: RegisteredAgentHooks[];
  readonly instructions: string[];
  readonly migrations: ThreadStateMigration[];
  readonly modelProviders: Map<string, CodingAgentExtensionModelProvider>;
  readonly owners: ExtensionContributionOwners;
  readonly renderers: ToolRendererMap;
  readonly resourceRoots: { prompts: string[]; skills: string[] };
  readonly sessionGuards: RegisteredSessionGuard[];
  readonly tools: ToolSet;
}

interface ExtensionContributionOwners {
  assistantRenderer?: string;
  /** Owner per fallback chain entry, parallel to `assistantRendererChain`. */
  readonly assistantRendererChain: string[];
  readonly commands: Map<string, string>;
  readonly migrations: Map<string, string>;
  readonly modelProviders: Map<string, string>;
  readonly renderers: Map<string, string>;
  readonly tools: Map<string, string>;
}

export function createExtensionRegistryCollections(): ExtensionRegistryCollections {
  return {
    assistantRendererChain: [],
    commands: [],
    events: [],
    hooks: [],
    instructions: [],
    migrations: [],
    modelProviders: new Map(),
    owners: {
      assistantRendererChain: [],
      commands: new Map(),
      migrations: new Map(),
      modelProviders: new Map(),
      renderers: new Map(),
      tools: new Map(),
    },
    renderers: Object.create(null) as ToolRendererMap,
    resourceRoots: { prompts: [], skills: [] },
    sessionGuards: [],
    tools: Object.create(null) as ToolSet,
  };
}

const OVERRIDE_HINT =
  "; register with { override: true } to replace the fallback";

/**
 * Validate assistant-renderer contributions across extensions. Fallback
 * renderers compose into a chain; an override replaces the chain; an
 * exclusive renderer requires an empty slot. Mutations happen in the main
 * commit path after every conflict check has passed.
 */
function commitAssistantRenderer(
  target: ExtensionRegistryCollections,
  staged: ExtensionRegistryCollections,
  extensionId: string
): void {
  const conflict = (owner: string | undefined, hint = ""): never => {
    throw new Error(
      `Assistant renderer from extension "${extensionId}" conflicts with extension "${owner ?? extensionId}"${hint}`
    );
  };
  const incoming = staged.assistantRenderer;
  if (incoming !== undefined) {
    if (target.assistantRenderer !== undefined) {
      conflict(target.owners.assistantRenderer);
    }
    if (!incoming.override && target.assistantRendererChain.length > 0) {
      conflict(target.owners.assistantRendererChain.at(-1), OVERRIDE_HINT);
    }
  }
  if (
    staged.assistantRendererChain.length > 0 &&
    target.assistantRenderer !== undefined
  ) {
    conflict(target.owners.assistantRenderer);
  }
}

export function commitExtensionRegistryCollections(
  target: ExtensionRegistryCollections,
  staged: ExtensionRegistryCollections,
  extensionId: string
): void {
  commitAssistantRenderer(target, staged, extensionId);
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
  target.sessionGuards.push(...staged.sessionGuards);
  if (staged.assistantRenderer !== undefined) {
    if (staged.assistantRenderer.override) {
      // An explicit override replaces the whole fallback chain.
      target.assistantRendererChain.length = 0;
      target.owners.assistantRendererChain.length = 0;
    }
    target.assistantRenderer = staged.assistantRenderer;
    target.owners.assistantRenderer = extensionId;
  }
  target.assistantRendererChain.push(...staged.assistantRendererChain);
  target.owners.assistantRendererChain.push(
    ...staged.assistantRendererChain.map(() => extensionId)
  );
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
