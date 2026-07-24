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
import { CodingAgentExtensionError } from "./error";
import { createCodingAgentExtensionInstrumentation } from "./events";
import { normalizeCodingAgentExtension } from "./factory";
import {
  DEFAULT_EXTENSION_TIMEOUT_MS,
  validateExtensionHostOptions,
} from "./host-validation";
import { createCodingAgentExtensionRegistry } from "./registry";
import {
  commitExtensionRegistryCollections,
  createExtensionRegistryCollections,
} from "./registry-collections";
import type {
  CodingAgentExtension,
  CodingAgentExtensionActivationContext,
  CodingAgentExtensionCleanup,
  CodingAgentExtensionHostOptions,
  CodingAgentExtensionInput,
  CodingAgentExtensionMode,
} from "./types";

export class CodingAgentExtensionHost {
  readonly #collections = createExtensionRegistryCollections();
  readonly #controller = new AbortController();
  readonly #extensions: readonly CodingAgentExtension[];
  readonly #timeoutMs: number;
  #activated = false;
  #cleanups: { cleanup: CodingAgentExtensionCleanup; id: string }[] = [];
  #disposed = false;

  private constructor(
    extensions: readonly CodingAgentExtension[],
    options: CodingAgentExtensionHostOptions
  ) {
    this.#extensions = extensions;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS;
  }

  static async create(
    extensions: readonly CodingAgentExtensionInput[],
    options: CodingAgentExtensionHostOptions = {}
  ): Promise<CodingAgentExtensionHost> {
    validateExtensionHostOptions(extensions, options);
    const host = new CodingAgentExtensionHost(
      extensions.map(normalizeCodingAgentExtension),
      options
    );
    try {
      await host.#configure();
      return host;
    } catch (error) {
      await host.dispose();
      throw error;
    }
  }

  get commands(): readonly TuiCommand[] {
    return [...this.#collections.commands];
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
            this.#controller.signal
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

  getToolOwner(name: string): string | undefined {
    return this.#collections.owners.tools.get(name);
  }

  getToolRendererOwner(name: string): string | undefined {
    return this.#collections.owners.renderers.get(name);
  }

  async activate(agent: Agent, mode: CodingAgentExtensionMode): Promise<void> {
    this.#assertUsable();
    if (this.#activated) {
      throw new Error("Coding agent extensions are already active");
    }
    this.#activated = true;
    const context: CodingAgentExtensionActivationContext = {
      agent,
      mode,
      signal: this.#controller.signal,
    };
    Object.freeze(context);
    try {
      for (const extension of this.#extensions) {
        if (!extension.activate) {
          continue;
        }
        const cleanup = await this.#run(extension.id, "activate", () =>
          extension.activate?.(context)
        );
        if (cleanup) {
          this.#cleanups.push({ cleanup, id: extension.id });
        }
      }
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#controller.abort();
    const failures: unknown[] = [];
    for (const { cleanup, id } of this.#cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(new CodingAgentExtensionError(id, "dispose", error));
      }
    }
    this.#cleanups = [];
    this.#collections.events.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Coding agent extension cleanup failed"
      );
    }
  }

  async #configure(): Promise<void> {
    for (const extension of this.#extensions) {
      let open = true;
      const staged = createExtensionRegistryCollections();
      const assertOpen = () => {
        if (!open || this.#controller.signal.aborted) {
          throw new Error(
            `Coding agent extension "${extension.id}" registration is closed`
          );
        }
      };
      const registry = createCodingAgentExtensionRegistry({
        assertOpen,
        collections: staged,
        extensionId: extension.id,
      });
      try {
        await this.#run(extension.id, "configure", async () => {
          await extension.configure(registry, {
            signal: this.#controller.signal,
          });
          assertOpen();
          commitExtensionRegistryCollections(
            this.#collections,
            staged,
            extension.id
          );
        });
      } finally {
        open = false;
      }
    }
  }

  async #run<Result>(
    extensionId: string,
    phase: "activate" | "configure",
    callback: () => Promise<Result> | Result
  ): Promise<Result> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        callback(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            this.#controller.abort();
            reject(
              new Error(
                `Coding agent extension timed out after ${this.#timeoutMs}ms`
              )
            );
          }, this.#timeoutMs);
        }),
      ]);
    } catch (error) {
      throw new CodingAgentExtensionError(extensionId, phase, error);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new Error("Coding agent extension host is disposed");
    }
  }
}

export async function createCodingAgentExtensionHost(
  extensions: readonly CodingAgentExtensionInput[],
  options?: CodingAgentExtensionHostOptions
): Promise<CodingAgentExtensionHost> {
  return await CodingAgentExtensionHost.create(extensions, options);
}
