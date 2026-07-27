import type { ModelMessage } from "ai";
import type { AgentHookRuntime } from "../../agent/core/hook-runtime";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionDecision,
  RuntimeToolExecutionResult,
} from "../../llm/tool-execution-types";
import type {
  HostAttachmentStore,
  RuntimeAttachmentReference,
} from "../input/attachments";
import type {
  AgentEvent,
  ModelUsage,
  StreamAgentEvent,
} from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadCompactionInput, ThreadState } from "../state/thread-state";
import { interceptAgentEvent } from "./event-interception";

interface ThreadEventDispatcherOptions {
  readonly attachmentStore?: HostAttachmentStore;
  readonly history: () => readonly ModelMessage[];
  readonly hookRuntime: AgentHookRuntime;
  readonly signal: () => AbortSignal | undefined;
  readonly threadKey: string;
}

interface InterceptEventOptions {
  readonly stagedRefs?: RuntimeAttachmentReference[];
}

export class ThreadEventDispatcher {
  readonly #attachmentStore: HostAttachmentStore | undefined;
  readonly #history: () => readonly ModelMessage[];
  #observerEventBuffer?: AgentEvent[];
  readonly #hookRuntime: AgentHookRuntime;
  readonly #signal: () => AbortSignal | undefined;
  readonly #threadKey: string;

  constructor(options: ThreadEventDispatcherOptions) {
    this.#attachmentStore = options.attachmentStore;
    this.#history = options.history;
    this.#hookRuntime = options.hookRuntime;
    this.#signal = options.signal;
    this.#threadKey = options.threadKey;
  }

  async captureObserverEvents<T>(
    run: BufferedAgentTurn,
    callback: () => Promise<T>
  ): Promise<{
    readonly events: AgentEvent[];
    readonly release: () => void;
    readonly value: T;
  }> {
    const previousBuffer = this.#observerEventBuffer;
    const buffer: AgentEvent[] = [];
    this.#observerEventBuffer = buffer;
    try {
      const value = await callback();
      return {
        events: buffer,
        release: () => {
          if (this.#observerEventBuffer === buffer) {
            this.#observerEventBuffer = previousBuffer;
          }
        },
        value,
      };
    } catch (error) {
      for (const event of buffer.splice(0)) {
        await this.emitRunEvent(run, event);
      }
      this.#observerEventBuffer = previousBuffer;
      throw error;
    }
  }

  emitObserverEvent(
    activeRun: BufferedAgentTurn | undefined,
    event: AgentEvent
  ): Promise<void> {
    const observerEventBuffer = this.#observerEventBuffer;
    if (observerEventBuffer) {
      observerEventBuffer.push(structuredClone(event));
      return Promise.resolve();
    }

    if (!activeRun) {
      return Promise.resolve();
    }

    return this.emitRunEvent(activeRun, event).then(() => undefined);
  }

  async emitRunBoundaryEvent(
    run: BufferedAgentTurn,
    event: AgentEvent,
    options: { readonly awaitAck?: boolean } = {}
  ): Promise<void> {
    const processed =
      event.type === "turn-start"
        ? await this.#hookRuntime.beforeTurnStart(
            this.#threadKey,
            event,
            this.#history(),
            this.#activeSignal()
          )
        : event;
    if (options.awaitAck === false) {
      run.emit(processed);
      return;
    }

    await run.emitBoundary(processed);
  }

  async emitRunEvent(
    run: BufferedAgentTurn,
    event: AgentEvent
  ): Promise<AgentEvent | "handled"> {
    const processed = await this.interceptEvent(event);
    if (processed === "handled") {
      return "handled";
    }

    run.emit(processed);
    return processed;
  }

  async emitModelUsageEvent(
    run: BufferedAgentTurn,
    event: ModelUsage,
    persistEvent?: (event: AgentEvent) => Promise<void> | void
  ): Promise<ModelUsage> {
    try {
      await persistEvent?.(event);
    } finally {
      run.emit(event);
    }
    return event;
  }

  async interceptBeforeToolCall(
    checkpoint: RuntimeToolExecutionCheckpoint
  ): Promise<RuntimeToolExecutionDecision> {
    return await this.#hookRuntime.beforeToolExecution(
      this.#threadKey,
      checkpoint,
      this.#history(),
      this.#activeSignal()
    );
  }

  async interceptAfterToolCall(
    checkpoint: RuntimeToolExecutionCheckpoint & { readonly output: unknown }
  ): Promise<RuntimeToolExecutionResult | undefined> {
    return await this.#hookRuntime.transformToolResult(
      this.#threadKey,
      checkpoint,
      this.#history(),
      this.#activeSignal()
    );
  }

  async compact(
    state: ThreadState,
    input: ThreadCompactionInput
  ): Promise<boolean> {
    const decision = await this.#hookRuntime.beforeCompaction(
      this.#threadKey,
      input,
      this.#history(),
      this.#activeSignal()
    );
    if (decision?.action === "cancel") {
      return false;
    }
    const compactedInput =
      decision?.action === "transform" ? decision.input : input;
    await state.compact(compactedInput);
    return true;
  }

  async interceptEvent(
    event: AgentEvent,
    options: InterceptEventOptions = {}
  ): Promise<AgentEvent | "handled"> {
    return await interceptAgentEvent(event, {
      attachmentStore: this.#attachmentStore,
      history: this.#history,
      hookRuntime: this.#hookRuntime,
      signal: () => this.#activeSignal(),
      stagedRefs: options.stagedRefs,
      threadKey: this.#threadKey,
    });
  }

  emitProcessedEvent(run: BufferedAgentTurn, event: AgentEvent): void {
    run.emit(event);
  }

  emitStreamEvent(run: BufferedAgentTurn, event: StreamAgentEvent): void {
    run.emit(event);
  }

  #activeSignal(): AbortSignal {
    return this.#signal() ?? new AbortController().signal;
  }
}
