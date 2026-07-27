import type { Agent } from "@minpeter/pss-runtime";
import { Fsm } from "@minpeter/pss-runtime/fsm";
import type { TuiCommandContext } from "../tui/command";
import { CodingAgentExtensionError } from "./error";
import { ExtensionHostEventBus } from "./event-bus";
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
  ExtensionJsonValue,
} from "./types";

/**
 * Host lifecycle: `idle -> activating -> active -> disposed`.
 *
 * `agent`/`mode` only exist while an activation is in progress or complete,
 * so "activated without an agent" is unrepresentable. `dispose()` may fire
 * from any state (including mid-activation); `disposed` keeps the last mode
 * so late service lookups keep resolving the way they used to.
 */
type HostLifecycleState =
  | { readonly tag: "idle" }
  | {
      readonly tag: "activating";
      readonly agent: Agent;
      readonly mode: CodingAgentExtensionMode;
    }
  | {
      readonly tag: "active";
      readonly agent: Agent;
      readonly mode: CodingAgentExtensionMode;
    }
  | { readonly tag: "disposed"; readonly mode?: CodingAgentExtensionMode };

function createHostLifecycleMachine(): Fsm<HostLifecycleState> {
  return new Fsm<HostLifecycleState>({
    initial: { tag: "idle" },
    name: "extension-host-lifecycle",
    transitions: {
      idle: ["activating", "disposed"],
      activating: ["active", "disposed"],
      active: ["disposed"],
      disposed: [],
    },
  });
}

export class ExtensionHostLifecycle {
  readonly #bus: ExtensionHostEventBus;
  #cleanups: { cleanup: CodingAgentExtensionCleanup; id: string }[] = [];
  readonly #collections: ExtensionRegistryCollections;
  readonly #controller = new AbortController();
  readonly #extensions: readonly CodingAgentExtension[];
  readonly #lifecycle = createHostLifecycleMachine();
  readonly #services: ExtensionHostServices;
  readonly #timeoutMs: number;

  constructor(
    extensions: readonly CodingAgentExtension[],
    options: CodingAgentExtensionHostOptions,
    collections: ExtensionRegistryCollections
  ) {
    this.#collections = collections;
    this.#extensions = extensions;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS;
    this.#bus = new ExtensionHostEventBus({
      signal: this.#controller.signal,
      timeoutMs: this.#timeoutMs,
    });
    this.#services = new ExtensionHostServices(options, this.#bus);
  }

  /**
   * Reject further extension state writes (draining already-admitted
   * writes) and release detached interactive UI work. Called when disposal
   * was detached by a timeout so late cleanup cannot overwrite state or
   * steal focus from a replacement runtime.
   */
  async revokeExtensionState(): Promise<void> {
    this.#services.revokeInteractiveUi();
    await this.#services.revokeStateWrites();
  }

  /** Publish a host-originated bus event such as a provider observation. */
  emitHostEvent(type: string, payload?: ExtensionJsonValue): void {
    if (this.#lifecycle.state.tag === "disposed") {
      return;
    }
    this.#bus.emitFromHost(type, payload);
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
    this.#assertNotActivated();
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
    this.#assertNotActivated();
    this.#services.assertMode(mode);
    this.#lifecycle.to({ tag: "activating", agent, mode });
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
        const cleanup = await this.#run(
          extension.id,
          "activate",
          async () => {
            const result = await activate(context);
            if (result !== undefined && typeof result !== "function") {
              throw new TypeError(
                `Coding agent extension "${extension.id}" activation handler must return a cleanup function`
              );
            }
            return result;
          },
          {
            onLateResult: async (result) => {
              if (typeof result === "function") {
                await result();
              }
            },
          }
        );
        if (cleanup !== undefined) {
          if (this.#lifecycle.state.tag === "disposed") {
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
    if (this.#lifecycle.state.tag === "activating") {
      this.#lifecycle.to({ tag: "active", agent, mode });
    }
  }

  async dispose(): Promise<void> {
    if (this.#lifecycle.state.tag === "disposed") {
      return;
    }
    this.#lifecycle.to({ tag: "disposed", mode: this.#mode });
    // Drain in-flight bus deliveries (bounded by the host timeout) before
    // aborting and running cleanups so handlers finish against live
    // services instead of resuming mid-teardown.
    await this.#bus.dispose();
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
    callback: () => Promise<Result> | Result,
    extras: {
      readonly onLateResult?: (result: Result) => void | Promise<void>;
    } = {}
  ): Promise<Result> {
    return await runExtensionOperation({
      callback,
      controller: this.#controller,
      extensionId,
      hasInteractiveUiRequests: () =>
        this.#services.hasInteractiveUiRequests(extensionId),
      ...(extras.onLateResult === undefined
        ? {}
        : { onLateResult: extras.onLateResult }),
      phase,
      timeoutMs: this.#timeoutMs,
    });
  }

  #assertUsable(): void {
    if (this.#lifecycle.state.tag === "disposed") {
      throw new Error("Coding agent extension host is disposed");
    }
  }

  #assertNotActivated(): void {
    if (this.#lifecycle.in("activating", "active")) {
      throw new Error("Coding agent extensions are already active");
    }
  }

  get #agent(): Agent | undefined {
    const lifecycle = this.#lifecycle.state;
    return lifecycle.tag === "activating" || lifecycle.tag === "active"
      ? lifecycle.agent
      : undefined;
  }

  get #mode(): CodingAgentExtensionMode | undefined {
    const lifecycle = this.#lifecycle.state;
    return lifecycle.tag === "idle" ? undefined : lifecycle.mode;
  }
}
