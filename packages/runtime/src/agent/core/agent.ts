import type { AgentHost, NotificationRecord } from "../../execution/host/types";
import type { ModelContextTokenEstimateInput } from "../../llm/context-gate";
import { createInMemoryHost } from "../../platform/memory";
import { noopRuntimeDiagnostics } from "../../plugins/diagnostics";
import { PluginRuntime } from "../../plugins/plugin-runtime";
import { AgentThread } from "../../thread/handle/agent-thread";
import type { AgentInput } from "../../thread/input/input";
import type { AgentTurn } from "../../thread/protocol/turn";
import type { ThreadStore } from "../../thread/store/types";
import { stableAgentNamespace } from "../identity/namespace";
import { resumeAgentTurn } from "../resume/resume";
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
  assertAgentOptions,
  type CreateAgentOptions,
  type NormalizedAgentAutoCompactionOptions,
  normalizeAgentAutoCompactionOptions,
  normalizePluginTimeoutOptions,
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
  NormalizedAgentAutoCompactionOptions,
} from "./options";
export type {
  ThreadAddress,
  ThreadHandle,
  ThreadKey,
  ThreadMetadata,
} from "./thread-entry";

/** Options for `new Agent(...)`. Plugins are only accepted via `createAgent`. */
export type AgentConstructorOptions = Omit<AgentOptions, "plugins">;

export class Agent {
  readonly #modelOptions: AgentModelOptions;
  readonly #threads = new Map<string, AgentThreadEntry>();
  readonly #ownerNamespace: string;
  readonly #store: ThreadStore;
  readonly #host: AgentHost;
  readonly #instrumentations: readonly AgentInstrumentation[];
  readonly #pluginRuntime?: PluginRuntime;
  readonly #notificationOverlays?: AgentOptions["notificationOverlays"];
  readonly #autoCompaction: NormalizedAgentAutoCompactionOptions;
  readonly host: AgentHost;
  readonly namespace?: string;
  constructor(options: AgentConstructorOptions, pluginRuntime?: PluginRuntime) {
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
    this.#pluginRuntime = pluginRuntime;
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
      contextGate: derivedContextGate(this.#autoCompaction),
      diagnostics: this.#host.diagnostics,
      instructions: options.instructions,
      model: options.model,
      prepareModelStep: options.prepareModelStep,
      toolChoice: options.toolChoice,
      toolOrder: options.toolOrder,
      tools: pluginRuntime?.tools ?? options.tools,
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
    await this.#pluginRuntime?.dispose();
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
      { key, store: this.#store },
      {
        autoCompaction: this.#autoCompaction,
        executionHost: this.#host,
        pluginRuntime: this.#pluginRuntime,
      }
    );
    const publicHandle = createThreadPublicHandle({
      evict: (evictedKey) => this.#evictThreadHandle(evictedKey),
      instrumentations: this.#instrumentations,
      key,
      namespace: this.namespace,
      pluginRuntime: this.#pluginRuntime,
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
  const definitions = options.plugins ?? [];
  if (definitions.length === 0) {
    return new Agent(options);
  }
  const timeouts = normalizePluginTimeoutOptions(options);
  const runtime = await PluginRuntime.create(definitions, {
    diagnostics: options.host?.diagnostics ?? noopRuntimeDiagnostics,
    ...timeouts,
    tools: options.tools,
  });
  try {
    return new Agent(options, runtime);
  } catch (cause) {
    await runtime.dispose();
    throw cause;
  }
}

function derivedContextGate(
  autoCompaction: NormalizedAgentAutoCompactionOptions
): AgentModelOptions["contextGate"] {
  if (autoCompaction.contextGate !== undefined) {
    return autoCompaction.contextGate;
  }

  const estimate = autoCompaction.estimateTokens;
  return {
    ...(estimate === undefined
      ? {}
      : {
          estimateTokens: ({
            instructions,
            messages,
          }: ModelContextTokenEstimateInput): number => {
            if (!instructions) {
              return estimate(messages);
            }
            return estimate([
              { content: instructions, role: "system" },
              ...messages,
            ]);
          },
        }),
    maxInputTokens: autoCompaction.maxInputTokens,
    onOverflow: "compact" as const,
  };
}
