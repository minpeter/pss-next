import type { Agent } from "@minpeter/pss-runtime";
import type { TuiCommandContext } from "../tui/command";
import { CodingAgentExtensionError } from "./error";
import { runExtensionOperation } from "./host-operation";
import { ExtensionHostServices } from "./host-services";
import { DEFAULT_EXTENSION_TIMEOUT_MS } from "./host-validation";
import { createCodingAgentExtensionRegistry } from "./registry";
import {
  commitExtensionRegistryCollections,
  createExtensionRegistryCollections,
  type ExtensionRegistryCollections,
} from "./registry-collections";
import type {
  CodingAgentExtension,
  CodingAgentExtensionActivationContext,
  CodingAgentExtensionCleanup,
  CodingAgentExtensionHostOptions,
  CodingAgentExtensionMode,
  CodingAgentExtensionServices,
  CodingAgentExtensionUi,
} from "./types";

export class ExtensionHostLifecycle {
  #activated = false;
  #agent: Agent | undefined;
  #cleanups: { cleanup: CodingAgentExtensionCleanup; id: string }[] = [];
  readonly #collections: ExtensionRegistryCollections;
  readonly #controller = new AbortController();
  #disposed = false;
  readonly #extensions: readonly CodingAgentExtension[];
  #mode: CodingAgentExtensionMode | undefined;
  readonly #services: ExtensionHostServices;
  readonly #timeoutMs: number;

  constructor(
    extensions: readonly CodingAgentExtension[],
    options: CodingAgentExtensionHostOptions,
    collections: ExtensionRegistryCollections
  ) {
    this.#collections = collections;
    this.#extensions = extensions;
    this.#services = new ExtensionHostServices(options);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  bindRuntimeServices(options: {
    readonly model: NonNullable<CodingAgentExtensionHostOptions["model"]>;
    readonly workspace: string;
  }): void {
    this.#assertUsable();
    if (this.#activated) {
      throw new Error("Coding agent extensions are already active");
    }
    this.#services.bindRuntimeServices(options);
  }

  bindUi(ui: CodingAgentExtensionUi): void {
    this.#assertUsable();
    this.#services.bindUi(ui, this.#mode);
  }

  getCommandContext(extensionId: string): TuiCommandContext {
    return this.#services.getCommandContext(extensionId, {
      agent: this.#agent,
      mode: this.#mode,
      providers: this.#collections.modelProviders,
      signal: this.#controller.signal,
    });
  }

  getServices(extensionId: string): CodingAgentExtensionServices {
    return this.#services.getServices(extensionId, {
      mode: this.#mode ?? "exec",
      providers: this.#collections.modelProviders,
      signal: this.#controller.signal,
    });
  }

  async configure(): Promise<void> {
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

  async activate(agent: Agent, mode: CodingAgentExtensionMode): Promise<void> {
    this.#assertUsable();
    if (this.#activated) {
      throw new Error("Coding agent extensions are already active");
    }
    this.#services.assertMode(mode);
    this.#activated = true;
    this.#agent = agent;
    this.#mode = mode;
    try {
      for (const extension of this.#extensions) {
        const activate = extension.activate;
        if (activate === undefined) {
          continue;
        }
        const context: CodingAgentExtensionActivationContext = Object.freeze({
          agent,
          mode,
          services: this.#services.getServices(extension.id, {
            mode,
            providers: this.#collections.modelProviders,
            signal: this.#controller.signal,
          }),
          signal: this.#controller.signal,
        });
        const cleanup = await this.#run(extension.id, "activate", async () => {
          const result = await activate(context);
          if (result !== undefined && typeof result !== "function") {
            throw new TypeError(
              `Coding agent extension "${extension.id}" activation handler must return a cleanup function`
            );
          }
          return result;
        });
        if (cleanup !== undefined) {
          if (this.#disposed) {
            await cleanup();
          } else {
            this.#cleanups.push({ cleanup, id: extension.id });
          }
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
    this.#agent = undefined;
    failures.push(...(await this.#services.dispose()));
    this.#collections.events.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Coding agent extension cleanup failed"
      );
    }
  }

  async #run<Result>(
    extensionId: string,
    phase: "activate" | "configure",
    callback: () => Promise<Result> | Result
  ): Promise<Result> {
    return await runExtensionOperation({
      callback,
      controller: this.#controller,
      extensionId,
      hasInteractiveUiRequests: () =>
        this.#services.hasInteractiveUiRequests(extensionId),
      phase,
      timeoutMs: this.#timeoutMs,
    });
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new Error("Coding agent extension host is disposed");
    }
  }
}
