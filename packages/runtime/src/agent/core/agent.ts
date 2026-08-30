import type { AgentHost, NotificationRecord } from "../../execution/host/types";
import {
  ContextTokenCalibrationRegistry,
  ContextTokenMeter,
} from "../../llm/context-tokens";
import { createInMemoryHost } from "../../platform/memory";
import { AgentThread } from "../../thread/handle/agent-thread";
import type { AgentInput } from "../../thread/input/input";
import type { AgentTurn } from "../../thread/protocol/turn";
import type { AgentCompaction } from "../../thread/runtime/auto-compaction-types";
import {
  normalizeThreadStateMigrations,
  type ThreadStateMigration,
} from "../../thread/state/migrations";
import type { ThreadStore } from "../../thread/store/types";
import { stableAgentNamespace } from "../identity/namespace";
import { type ClaimedTurnRecord, resumeAgentTurn } from "../resume/resume";
import { AgentHookRuntime } from "./hook-runtime";
import { threadStoreForHost } from "./host-thread-store";
import {
  type AgentInstrumentation,
  type AgentInstrumentationContext,
  applyAgentInstrumentations,
  normalizeAgentInstrumentations,
} from "./instrumentation";
import {
  type AgentModelOptions,
  type AgentOptions,
  type CreateAgentOptions,
  consumeAgentOptions,
  snapshotAgentOptions,
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
  readonly #contextTokenRegistry = new ContextTokenCalibrationRegistry();
  readonly #contextTokens?: AgentOptions["contextTokens"];
  readonly #ownerNamespace: string;
  readonly #store: ThreadStore;
  readonly #host: AgentHost;
  readonly #instrumentations: readonly AgentInstrumentation[];
  readonly #hookRuntime: AgentHookRuntime;
  readonly #notificationOverlays?: AgentOptions["notificationOverlays"];
  readonly #threadMigrations: readonly ThreadStateMigration[];
  readonly #compaction?: AgentCompaction;
  readonly host: AgentHost;
  readonly namespace?: string;
  constructor(options: AgentConstructorOptions) {
    const validatedOptions = consumeAgentOptions(options);

    const providedHost = validatedOptions.host;
    this.namespace = validatedOptions.namespace;
    this.#ownerNamespace = stableAgentNamespace({
      namespace: validatedOptions.namespace,
    });
    this.#host = providedHost ?? createInMemoryHost();
    this.host = this.#host;
    this.#store = threadStoreForHost(this.#host);
    this.#instrumentations = normalizeAgentInstrumentations(
      validatedOptions.instrumentations
    );
    this.#threadMigrations = normalizeThreadStateMigrations(
      validatedOptions.threadMigrations
    );
    this.#hookRuntime = new AgentHookRuntime(validatedOptions.hooks);
    this.#notificationOverlays = validatedOptions.notificationOverlays;
    this.#compaction = validatedOptions.compaction;
    this.#contextTokens = validatedOptions.contextTokens;
    this.#modelOptions = {
      alwaysActiveTools: validatedOptions.alwaysActiveTools,
      attachmentStore:
        providedHost?.attachmentStore ??
        validatedOptions.attachmentStore ??
        this.#host.attachmentStore,
      contextGate: validatedOptions.compaction?.maxInputTokens
        ? {
            ...validatedOptions.compaction,
            maxInputTokens: validatedOptions.compaction.maxInputTokens,
          }
        : false,
      diagnostics: this.#host.diagnostics,
      instructions: validatedOptions.instructions,
      model: validatedOptions.model,
      prepareModelStep: validatedOptions.prepareModelStep,
      toolChoice: validatedOptions.toolChoice,
      toolOrder: validatedOptions.toolOrder,
      tools: validatedOptions.tools,
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

  followUp(input: AgentInput): Promise<AgentTurn> {
    return this.thread("default").followUp(input);
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
  async resume(
    runId: string,
    options: {
      readonly captureLeaseId?: (leaseId: string) => void;
    } = {}
  ): Promise<AgentTurn | null> {
    return await resumeAgentTurn({
      captureLeaseId: options.captureLeaseId,
      host: this.#host,
      ownerNamespace: this.#ownerNamespace,
      resumeNotification: (notification, run) =>
        this.#resumeNotification(notification, run),
      runId,
    });
  }

  thread(thread: ThreadKey): ThreadHandle {
    return this.#threadEntry(threadStoreKey(thread)).publicHandle;
  }

  async dispose(): Promise<void> {
    let failed = false;
    let failure: unknown;
    for (const entry of [...this.#threads.values()]) {
      const outcome = await entry.publicHandle.dispose().then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ error, ok: false }) as const
      );
      if (!(outcome.ok || failed)) {
        failed = true;
        failure = outcome.error;
      }
    }
    this.#threads.clear();
    if (failed) {
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
      {
        ...this.#modelOptions,
        contextTokenMeter: new ContextTokenMeter(
          this.#contextTokenRegistry,
          this.#contextTokens
        ),
        contextTokens: this.#contextTokens,
      },
      { key, migrations: this.#threadMigrations, store: this.#store },
      {
        compaction: this.#compaction,
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
    run: ClaimedTurnRecord
  ): Promise<AgentTurn> {
    const turn = await this.#threadEntry(notification.threadKey).notify(
      notification.input,
      {
        executionRun: {
          kind: "notification",
          leaseId: run.lease.leaseId,
          runId: notification.runId,
        },
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
      runId: run.runId,
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
  const validatedOptions = snapshotAgentOptions(options);
  return await new Agent(validatedOptions);
}
