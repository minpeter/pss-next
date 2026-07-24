import type {
  Agent,
  AgentHooks,
  AgentInstrumentation,
  ThreadStateMigration,
} from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import type { TuiCommand } from "../tui/command";
import type { ToolRendererMap } from "../tui/tool-call-view";
import { composeAgentHooks } from "./compose-hooks";
import { createCodingAgentExtensionInstrumentation } from "./events";
import { normalizeCodingAgentExtension } from "./factory";
import { ExtensionHostLifecycle } from "./host-lifecycle";
import { validateExtensionHostOptions } from "./host-validation";
import {
  createExtensionRegistryCollections,
  type ExtensionRegistryCollections,
} from "./registry-collections";
import type {
  CodingAgentExtension,
  CodingAgentExtensionHostOptions,
  CodingAgentExtensionInput,
  CodingAgentExtensionMode,
  CodingAgentExtensionUi,
} from "./types";

export class CodingAgentExtensionHost {
  readonly #collections: ExtensionRegistryCollections;
  readonly #lifecycle: ExtensionHostLifecycle;

  private constructor(
    extensions: readonly CodingAgentExtension[],
    options: CodingAgentExtensionHostOptions
  ) {
    this.#collections = createExtensionRegistryCollections();
    this.#lifecycle = new ExtensionHostLifecycle(
      extensions,
      options,
      this.#collections
    );
  }

  static async create(
    extensions: readonly CodingAgentExtensionInput[],
    options: CodingAgentExtensionHostOptions = {}
  ): Promise<CodingAgentExtensionHost> {
    validateExtensionHostOptions(extensions, options);
    const configuredExtensions = Object.fromEntries(
      extensions.flatMap((extension) =>
        extension.config === undefined
          ? []
          : [[extension.id, extension.config] as const]
      )
    );
    const host = new CodingAgentExtensionHost(
      extensions.map(normalizeCodingAgentExtension),
      {
        ...options,
        config: {
          ...configuredExtensions,
          ...options.config,
        },
      }
    );
    try {
      await host.#lifecycle.configure();
      return host;
    } catch (error) {
      await host.dispose();
      throw error;
    }
  }

  get commands(): readonly TuiCommand[] {
    return this.#collections.commands.map((command) => {
      const extensionId = this.#collections.owners.commands.get(command.name);
      if (extensionId === undefined) {
        return command;
      }
      return {
        ...command,
        execute: async (input) =>
          await command.execute(
            input,
            this.#lifecycle.getCommandContext(extensionId)
          ),
      };
    });
  }

  get hooks(): AgentHooks | undefined {
    return this.#collections.hooks.length === 0
      ? undefined
      : composeAgentHooks(this.#collections.hooks);
  }

  get instrumentations(): readonly AgentInstrumentation[] {
    return this.#collections.events.length === 0
      ? []
      : [
          createCodingAgentExtensionInstrumentation(
            this.#collections.events,
            this.#lifecycle.signal,
            (extensionId) => this.#lifecycle.getServices(extensionId)
          ),
        ];
  }

  get instructionFragments(): readonly string[] {
    return [...this.#collections.instructions];
  }

  get toolRenderers(): ToolRendererMap {
    return { ...this.#collections.renderers };
  }

  get tools(): ToolSet {
    return { ...this.#collections.tools };
  }

  get threadMigrations(): readonly ThreadStateMigration[] {
    return [...this.#collections.migrations];
  }

  bindRuntimeServices(options: {
    readonly model: NonNullable<CodingAgentExtensionHostOptions["model"]>;
    readonly workspace: string;
  }): void {
    this.#lifecycle.bindRuntimeServices(options);
  }

  bindUi(ui: CodingAgentExtensionUi): void {
    this.#lifecycle.bindUi(ui);
  }

  getToolOwner(name: string): string | undefined {
    return this.#collections.owners.tools.get(name);
  }

  getToolRendererOwner(name: string): string | undefined {
    return this.#collections.owners.renderers.get(name);
  }

  getModelProviderOwner(id: string): string | undefined {
    return this.#collections.owners.modelProviders.get(id);
  }

  async activate(agent: Agent, mode: CodingAgentExtensionMode): Promise<void> {
    await this.#lifecycle.activate(agent, mode);
  }

  async dispose(): Promise<void> {
    await this.#lifecycle.dispose();
  }
}

export async function createCodingAgentExtensionHost(
  extensions: readonly CodingAgentExtensionInput[],
  options?: CodingAgentExtensionHostOptions
): Promise<CodingAgentExtensionHost> {
  return await CodingAgentExtensionHost.create(extensions, options);
}
