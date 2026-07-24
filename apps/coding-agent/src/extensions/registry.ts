import type { AgentEvent, AgentHooks } from "@minpeter/pss-runtime";
import type { ToolRendererMap } from "../tui/tool-call-view";
import type { ExtensionCapability } from "./capabilities";
import {
  snapshotCommand,
  snapshotInstruction,
  snapshotThreadMigration,
  snapshotToolEntry,
  type ValidatedCapability,
  validateExtensionCapability,
} from "./capability-validation";
import type { RegisteredCodingAgentExtensionEvent } from "./events";
import { snapshotToolRendererName } from "./name-validation";
import type { ExtensionRegistryCollections } from "./registry-collections";
import {
  assertNoCommandConflicts,
  recordCommandOwners,
} from "./registry-conflicts";
import type {
  CodingAgentExtensionEventContext,
  CodingAgentExtensionEventHandler,
  CodingAgentExtensionRegistry,
} from "./types";

const EXTENSION_EVENT_TYPES = Object.freeze({
  "assistant-output": true,
  "assistant-output-delta": true,
  "assistant-reasoning": true,
  "assistant-reasoning-delta": true,
  "model-usage": true,
  "runtime-input": true,
  "step-end": true,
  "step-start": true,
  "tool-call": true,
  "tool-call-input-delta": true,
  "tool-call-input-end": true,
  "tool-call-input-start": true,
  "tool-result": true,
  "turn-abort": true,
  "turn-end": true,
  "turn-error": true,
  "turn-start": true,
  "user-input": true,
} satisfies Record<AgentEvent["type"], true>);

interface CreateExtensionRegistryOptions {
  readonly assertOpen: () => void;
  readonly collections: ExtensionRegistryCollections;
  readonly extensionId: string;
}

export function createCodingAgentExtensionRegistry({
  assertOpen,
  collections,
  extensionId,
}: CreateExtensionRegistryOptions): CodingAgentExtensionRegistry {
  const registerCommand = (value: unknown) => {
    assertOpen();
    const command = snapshotCommand(value);
    assertNoCommandConflicts(
      collections.commands,
      [command],
      collections.owners.commands,
      extensionId
    );
    collections.commands.push(command);
    recordCommandOwners(collections.owners.commands, [command], extensionId);
  };
  const registerInstruction = (value: unknown) => {
    assertOpen();
    collections.instructions.push(snapshotInstruction(value));
  };
  const registerMigration = (value: unknown) => {
    assertOpen();
    const migration = snapshotThreadMigration(extensionId, value);
    if (collections.migrations.some(({ id }) => id === migration.id)) {
      const existingOwner =
        collections.owners.migrations.get(migration.id) ?? extensionId;
      throw new Error(
        `Thread migration "${migration.id}" from extension "${extensionId}" conflicts with extension "${existingOwner}"`
      );
    }
    collections.migrations.push(migration);
    collections.owners.migrations.set(migration.id, extensionId);
  };
  const registerRenderer = (toolNameValue: unknown, renderer: unknown) => {
    assertOpen();
    const toolName = snapshotToolRendererName(toolNameValue);
    if (typeof renderer !== "function") {
      throw new TypeError(`Tool renderer "${toolName}" must be a function`);
    }
    if (Object.hasOwn(collections.renderers, toolName)) {
      const existingOwner =
        collections.owners.renderers.get(toolName) ?? extensionId;
      throw new Error(
        `Tool renderer "${toolName}" from extension "${extensionId}" conflicts with extension "${existingOwner}"`
      );
    }
    collections.renderers[toolName] = renderer as ToolRendererMap[string];
    collections.owners.renderers.set(toolName, extensionId);
  };
  const registerTool = (nameValue: unknown, definition: unknown) => {
    assertOpen();
    const [name, tool] = snapshotToolEntry(nameValue, definition);
    if (Object.hasOwn(collections.tools, name)) {
      const existingOwner = collections.owners.tools.get(name) ?? extensionId;
      throw new Error(
        `Tool "${name}" from extension "${extensionId}" conflicts with extension "${existingOwner}"`
      );
    }
    collections.tools[name] = tool;
    collections.owners.tools.set(name, extensionId);
  };
  const use = (hooks: AgentHooks) => {
    assertOpen();
    collections.hooks.push({ extensionId, hooks });
  };
  const registerModelProvider = (
    provider: Extract<
      ValidatedCapability,
      { readonly kind: "model-provider" }
    >["provider"]
  ) => {
    if (collections.modelProviders.has(provider.id)) {
      const existingOwner =
        collections.owners.modelProviders.get(provider.id) ?? extensionId;
      throw new Error(
        `Model provider "${provider.id}" from extension "${extensionId}" conflicts with extension "${existingOwner}"`
      );
    }
    collections.modelProviders.set(provider.id, provider);
    collections.owners.modelProviders.set(provider.id, extensionId);
  };
  const registerProvidedTools = (
    entries: Extract<ValidatedCapability, { readonly kind: "tools" }>["entries"]
  ) => {
    for (const [name] of entries) {
      if (Object.hasOwn(collections.tools, name)) {
        const existingOwner = collections.owners.tools.get(name) ?? extensionId;
        throw new Error(
          `Tool "${name}" from extension "${extensionId}" conflicts with extension "${existingOwner}"`
        );
      }
    }
    for (const [name, tool] of entries) {
      collections.tools[name] = tool;
      collections.owners.tools.set(name, extensionId);
    }
  };
  const provide = (capability: ExtensionCapability) => {
    assertOpen();
    const validated = validateExtensionCapability(capability, extensionId);
    switch (validated.kind) {
      case "command":
        registerCommand(validated.command);
        return;
      case "instructions":
        for (const fragment of validated.fragments) {
          registerInstruction(fragment);
        }
        return;
      case "model-provider":
        registerModelProvider(validated.provider);
        return;
      case "thread-migration":
        if (
          collections.migrations.some(({ id }) => id === validated.migration.id)
        ) {
          const existingOwner =
            collections.owners.migrations.get(validated.migration.id) ??
            extensionId;
          throw new Error(
            `Thread migration "${validated.migration.id}" from extension "${extensionId}" conflicts with extension "${existingOwner}"`
          );
        }
        collections.migrations.push(validated.migration);
        collections.owners.migrations.set(validated.migration.id, extensionId);
        return;
      case "tool-renderer":
        registerRenderer(validated.toolName, validated.renderer);
        return;
      case "tools":
        registerProvidedTools(validated.entries);
        return;
      default: {
        const unreachable: never = validated;
        throw new TypeError(`Unknown extension capability: ${unreachable}`);
      }
    }
  };
  return {
    commands: { register: registerCommand },
    instructions: { append: registerInstruction },
    on: (type, handler) => {
      registerEvent(collections.events, extensionId, type, handler, assertOpen);
    },
    provide,
    runtime: { use },
    storage: { registerThreadMigration: registerMigration },
    tools: { register: registerTool },
    tui: { registerToolRenderer: registerRenderer },
    use,
  };
}

function registerEvent<Type extends AgentEvent["type"]>(
  events: RegisteredCodingAgentExtensionEvent[],
  extensionId: string,
  type: Type,
  handler: CodingAgentExtensionEventHandler<Type>,
  assertOpen: () => void
): void {
  assertOpen();
  if (!Object.hasOwn(EXTENSION_EVENT_TYPES, type)) {
    throw new TypeError(`Unknown extension event "${type}"`);
  }
  if (typeof handler !== "function") {
    throw new TypeError(`Extension event "${type}" handler must be a function`);
  }
  events.push({
    extensionId,
    invoke: async (
      event: AgentEvent,
      context: CodingAgentExtensionEventContext
    ) => {
      await handler(
        event as Extract<AgentEvent, { readonly type: Type }>,
        context
      );
    },
    type,
  });
}
