import type { AgentHost, NotificationRecord } from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { AgentThread } from "../../thread/handle/agent-thread";
import type { AgentInput } from "../../thread/input/input";
import type { AgentTurn } from "../../thread/protocol/turn";
import {
  normalizeThreadStateMigrations,
  type ThreadStateMigration,
} from "../../thread/state/migrations";
import type { ThreadStore } from "../../thread/store/types";
import { stableAgentNamespace } from "../identity/namespace";
import { resumeAgentTurn } from "../resume/resume";
import { AgentHookRuntime } from "./hook-runtime";
import { threadStoreForHost } from "./host-thread-store";
import {
  type AgentInstrumentation,
  type AgentInstrumentationContext,
  applyAgentInstrumentations,
  normalizeAgentInstrumentations,
} from "./instrumentation";
import {
  type AgentAutoCompactionOptions,
  type AgentModelOptions,
  type AgentOptions,
  assertAgentOptions,
  type CreateAgentOptions,
  normalizeAgentAutoCompactionOptions,
} from "./options";
import {
  type AgentThreadEntry,
  type ThreadHandle,
  type ThreadKey,
  threadStoreKey,
} from "./thread-entry";
import { createThreadPublicHandle } from "./thread-handle-factory";

export type { AgentHost } from "../../execution/host/types";
export type { ThreadCompactionInput } from "../../thread/state/thread-state";
export type {
  AgentInstrumentation,
  AgentInstrumentationContext,
  AgentInstrumentationOperation,
} from "./instrumentation";
export type {
  AgentAutoCompactionOptions,
  AgentOptions,
  CreateAgentOptions,
} from "./options";
export type {
  ThreadAddress,
  ThreadHandle,
  ThreadKey,
  ThreadMetadata,
} from "./thread-entry";

export type AgentConstructorOptions = AgentOptions;

export class Agent {
  readonly #modelOptions: AgentModelOptions;
  readonly #threads = new Map<string, AgentThreadEntry>();
  readonly #ownerNamespace: string;
  readonly #store: ThreadStore;
  readonly #host: AgentHost;
  readonly #instrumentations: readonly AgentInstrumentation[];
  readonly #hookRuntime: AgentHookRuntime;
  readonly #notificationOverlays?: AgentOptions["notificationOverlays"];
  readonly #threadMigrations: readonly ThreadStateMigration[];
  readonly #autoCompaction?: AgentAutoCompactionOptions;
  readonly host: AgentHost;
  readonly namespace?: string;
  constructor(options: AgentConstructorOptions) {
    assertAgentOptions(options);

    const providedHost = options.host;
    this.namespace = options.namespace;
    this.#ownerNamespace = stableAgentNamespace({
      namespace: options.namespace,
    });
    this.#host = providedHost ?? createInMemoryHost();
    this.host = this.#host;
    this.#store = threadStoreForHost(this.#host);
    this.#instrumentations = normalizeAgentInstrumentations(
      options.instrumentations
    );
    this.#threadMigrations = normalizeThreadStateMigrations(
      options.threadMigrations
    );
    this.#hookRuntime = new AgentHookRuntime(options.hooks);
    this.#notificationOverlays = options.notificationOverlays;
    this.#autoCompaction = normalizeAgentAutoCompactionOptions(
      options.autoCompaction
    );
    this.#modelOptions = {
      alwaysActiveTools: options.alwaysActiveTools,
      attachmentStore:
        providedHost?.attachmentStore ??
        options.attachmentStore ??
        this.#host.attachmentStore,
      contextGate: this.#autoCompaction?.contextGate,
      diagnostics: this.#host.diagnostics,
      instructions: options.instructions,
      model: options.model,
      prepareModelStep: options.prepareModelStep,
      toolChoice: options.toolChoice,
      toolOrder: options.toolOrder,
      tools: options.tools,
    };
  }

  /**
   * Whether this agent's host can resume durable runs through `resume()`.
   * Always true for the single AgentHost contract.
   */
  get supportsResume(): boolean {
    return true;
  }

  send(input: AgentInput): Promise<AgentTurn> {
    return this.thread("default").send(input);
  }

  overlay(input: AgentInput): ThreadHandle {
    return this.thread("default").overlay(input);
  }

  /**
   * Resume a durable run by id. Returns the resumed `AgentTurn`, or `null` when
   * the host does not support durable resume (`supportsResume === false`), the
   * run id is unknown to this namespace, or a duplicate queue/alarm delivery
   * already claimed it. This never throws for a missing host; check
   * `supportsResume` first when you need to distinguish unsupported from
   * not-found.
   */
  async resume(runId: string): Promise<AgentTurn | null> {
    return await resumeAgentTurn({
      host: this.#host,
      ownerNamespace: this.#ownerNamespace,
      resumeNotification: (notification) =>
        this.#resumeNotification(notification, runId),
      runId,
    });
  }

  thread(thread: ThreadKey): ThreadHandle {
    return this.#threadEntry(threadStoreKey(thread)).publicHandle;
  }

  async dispose(): Promise<void> {
    let failure: unknown;
    for (const entry of [...this.#threads.values()]) {
      try {
        await entry.publicHandle.dispose();
      } catch (error) {
        failure ??= error;
      }
    }
    this.#threads.clear();
    if (failure !== undefined) {
      throw failure;
    }
  }

  #threadEntry(key: string): AgentThreadEntry {
    const existing = this.#threads.get(key);
    if (existing) {
      return existing;
    }

    let thread: AgentThread | undefined;
    thread = new AgentThread(
      this.#modelOptions,
      { key, migrations: this.#threadMigrations, store: this.#store },
      {
        autoCompaction: this.#autoCompaction,
        executionHost: this.#host,
        hookRuntime: this.#hookRuntime,
      }
    );
    const publicHandle = createThreadPublicHandle({
      evict: (evictedKey) => this.#evictThreadHandle(evictedKey),
      instrumentations: this.#instrumentations,
      key,
      namespace: this.namespace,
      thread,
    });
    const entry: AgentThreadEntry = {
      notify: (input, options) => thread.notify(input, options),
      publicHandle,
    };
    this.#threads.set(key, entry);
    return entry;
  }

  #evictThreadHandle(key: string): void {
    this.#threads.delete(key);
  }

  async #resumeNotification(
    notification: NotificationRecord,
    runId: string
  ): Promise<AgentTurn> {
    const turn = await this.#threadEntry(notification.threadKey).notify(
      notification.input,
      {
        executionRun: { kind: "notification", runId: notification.runId },
        observerEvents: notification.observerEvents,
        overlays: [
          ...(notification.overlays ?? []),
          ...(this.#notificationOverlays ?? []),
        ],
      }
    );
    return this.#instrumentTurn(turn, {
      namespace: this.namespace,
      operation: "resume",
      runId,
      threadKey: notification.threadKey,
    });
  }

  #instrumentTurn(
    turn: AgentTurn,
    context: AgentInstrumentationContext
  ): AgentTurn {
    return applyAgentInstrumentations(turn, this.#instrumentations, context);
  }
}

export async function createAgent(options: CreateAgentOptions): Promise<Agent> {
  assertAgentOptions(options);
  return await new Agent(options);
}
