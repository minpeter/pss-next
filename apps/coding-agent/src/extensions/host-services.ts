import type { Agent } from "@minpeter/pss-runtime";
import type { TuiCommandContext } from "../tui/command";
import { CodingAgentExtensionError } from "./error";
import type { ExtensionHostEventBus } from "./event-bus";
import {
  createExtensionServiceScope,
  type ExtensionServiceScope,
} from "./runtime-services";
import type {
  CodingAgentExtensionHostOptions,
  CodingAgentExtensionMode,
  CodingAgentExtensionModelProvider,
  CodingAgentExtensionServices,
  CodingAgentExtensionUi,
} from "./types";

interface ExtensionServiceContext {
  readonly mode: CodingAgentExtensionMode;
  readonly providers: ReadonlyMap<string, CodingAgentExtensionModelProvider>;
  readonly signal: AbortSignal;
}

interface ExtensionCommandContext {
  readonly agent: Agent | undefined;
  readonly mode: CodingAgentExtensionMode | undefined;
  readonly providers: ReadonlyMap<string, CodingAgentExtensionModelProvider>;
  readonly signal: AbortSignal;
}

export class ExtensionHostServices {
  readonly #bus: ExtensionHostEventBus;
  readonly #config: CodingAgentExtensionHostOptions["config"];
  readonly #dataRoot: string | undefined;
  readonly #interactiveUiRequests = new Map<string, number>();
  #model: CodingAgentExtensionHostOptions["model"];
  readonly #scopes = new Map<string, ExtensionServiceScope>();
  #ui: CodingAgentExtensionUi | undefined;
  #workspace: string | undefined;

  constructor(
    options: CodingAgentExtensionHostOptions,
    bus: ExtensionHostEventBus
  ) {
    this.#bus = bus;
    this.#config = options.config;
    this.#dataRoot = options.dataRoot;
    this.#model = options.model;
    this.#workspace = options.workspace;
  }

  hasInteractiveUiRequests(extensionId: string): boolean {
    return (this.#interactiveUiRequests.get(extensionId) ?? 0) > 0;
  }

  bindRuntimeServices(options: {
    readonly model: NonNullable<CodingAgentExtensionHostOptions["model"]>;
    readonly workspace: string;
  }): void {
    this.#model = options.model;
    this.#workspace = options.workspace;
  }

  bindUi(
    ui: CodingAgentExtensionUi,
    mode: CodingAgentExtensionMode | undefined
  ): void {
    if (mode === "exec") {
      throw new Error("Cannot bind interactive UI in exec mode");
    }
    this.#ui = ui;
  }

  assertMode(mode: CodingAgentExtensionMode): void {
    if (mode === "exec" && this.#ui !== undefined) {
      throw new Error("Cannot bind interactive UI in exec mode");
    }
  }

  getCommandContext(
    extensionId: string,
    options: ExtensionCommandContext
  ): TuiCommandContext {
    if (options.agent === undefined || options.mode === undefined) {
      throw new Error(`Coding agent extension "${extensionId}" is not active`);
    }
    return Object.freeze({
      agent: options.agent,
      mode: options.mode,
      services: this.getServices(extensionId, {
        mode: options.mode,
        providers: options.providers,
        signal: options.signal,
      }),
      signal: options.signal,
      workspace: this.#workspace ?? process.cwd(),
    });
  }

  getServices(
    extensionId: string,
    options: ExtensionServiceContext
  ): CodingAgentExtensionServices {
    return (
      this.#scopes.get(extensionId) ?? this.#createScope(extensionId, options)
    ).services;
  }

  /** Reject further extension state writes across every service scope. */
  revokeStateWrites(): void {
    for (const scope of this.#scopes.values()) {
      scope.revokeStateWrites();
    }
  }

  async dispose(): Promise<readonly unknown[]> {
    const failures: unknown[] = [];
    const scopes = [...this.#scopes.entries()].reverse();
    this.#scopes.clear();
    for (const [id, scope] of scopes) {
      try {
        await scope.dispose();
      } catch (error) {
        failures.push(new CodingAgentExtensionError(id, "dispose", error));
      }
    }
    return failures;
  }

  async #withInteractiveUi<Value>(
    extensionId: string,
    operation: () => Promise<Value>
  ): Promise<Value> {
    this.#interactiveUiRequests.set(
      extensionId,
      (this.#interactiveUiRequests.get(extensionId) ?? 0) + 1
    );
    try {
      return await operation();
    } finally {
      const count = (this.#interactiveUiRequests.get(extensionId) ?? 1) - 1;
      if (count === 0) {
        this.#interactiveUiRequests.delete(extensionId);
      } else {
        this.#interactiveUiRequests.set(extensionId, count);
      }
    }
  }

  #createScope(
    extensionId: string,
    options: ExtensionServiceContext
  ): ExtensionServiceScope {
    const scope = createExtensionServiceScope({
      config: this.#config?.[extensionId],
      ...(this.#dataRoot === undefined ? {} : { dataRoot: this.#dataRoot }),
      events: Object.freeze({
        emit: (
          type: string,
          payload?: Parameters<ExtensionHostEventBus["emitFromExtension"]>[2]
        ) => this.#bus.emitFromExtension(extensionId, type, payload),
        on: (
          type: string,
          handler: Parameters<ExtensionHostEventBus["subscribe"]>[2]
        ) => this.#bus.subscribe(extensionId, type, handler),
      }),
      extensionId,
      mode: options.mode,
      model: this.#model,
      providers: options.providers,
      signal: options.signal,
      ...(this.#ui === undefined ? {} : { ui: this.#uiFor(extensionId) }),
      ...(this.#workspace === undefined ? {} : { workspace: this.#workspace }),
    });
    this.#scopes.set(extensionId, scope);
    return scope;
  }

  #uiFor(extensionId: string): CodingAgentExtensionUi {
    const ui = this.#ui;
    if (ui === undefined) {
      throw new Error("Interactive extension UI is unavailable");
    }
    return Object.freeze({
      ...ui,
      confirm: async (
        message: Parameters<CodingAgentExtensionUi["confirm"]>[0]
      ) =>
        await this.#withInteractiveUi(extensionId, () => ui.confirm(message)),
      input: async (input: Parameters<CodingAgentExtensionUi["input"]>[0]) =>
        await this.#withInteractiveUi(extensionId, () => ui.input(input)),
      select: async (input: Parameters<CodingAgentExtensionUi["select"]>[0]) =>
        await this.#withInteractiveUi(extensionId, () => ui.select(input)),
    });
  }
}
