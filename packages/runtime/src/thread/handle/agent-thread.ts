import type {
  StoredThreadEvent,
  ThreadEventReadOptions,
} from "../../execution/host/types";
import { deferred } from "../../internal/deferred";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { AgentInput, UserInput } from "../input/input";
import type { AgentTurn } from "../protocol/turn";
import type {
  CompactionSummaryOptions,
  ManualThreadCompactionResult,
} from "../runtime/auto-compaction-types";
import type { ThreadExecutionOptions } from "../runtime/execution";
import type { NotifyOptions } from "../runtime/notification";
import { queueThreadNotification } from "../runtime/notification";
import { readThreadEvents } from "../runtime/thread-event-replay";
import type {
  ThreadCompactionInput,
  ThreadPersistenceOptions,
} from "../state/thread-state";
import {
  queueAgentThreadInput,
  recoverAgentThreadDurableInputClaims,
} from "./agent-thread-admission";
import { compactAgentThread } from "./agent-thread-compaction";
import {
  type AgentThreadContext,
  createAgentThreadContext,
} from "./agent-thread-context";
import { drainAgentThreadInputQueue } from "./agent-thread-drain";
import { killAgentThread } from "./agent-thread-kill";
import {
  assertAgentThreadOpen,
  ensureAgentThreadStarted,
} from "./agent-thread-lifecycle";
import {
  activeTurnRun,
  activeTurnRuntimeInput,
  assertThreadMachineInvariants,
  turnAbort,
} from "./agent-thread-machines";
import { addDurableSteeringInput } from "./durable-steering";
import { createOverlayRuntimeInput } from "./thread-overlay";

export class AgentThread {
  readonly #context: AgentThreadContext;

  constructor(
    model: ModelGenerationOptions,
    persistence: ThreadPersistenceOptions,
    execution: ThreadExecutionOptions = {}
  ) {
    this.#context = createAgentThreadContext(model, persistence, execution);
  }

  async send(input: AgentInput): Promise<AgentTurn> {
    return await queueAgentThreadInput(this.#context, input, "send");
  }

  /** Queue a durable user turn that starts only after the active turn ends. */
  async followUp(input: AgentInput): Promise<AgentTurn> {
    return await queueAgentThreadInput(this.#context, input, "follow-up");
  }

  overlay(input: AgentInput): this {
    assertAgentThreadOpen(this.#context);

    this.#context.pendingOverlays.push(createOverlayRuntimeInput(input));
    return this;
  }

  async notify(
    input: AgentInput | UserInput,
    options: NotifyOptions = {}
  ): Promise<AgentTurn> {
    assertAgentThreadOpen(this.#context);

    await ensureAgentThreadStarted(this.#context);
    await recoverAgentThreadDurableInputClaims(this.#context);

    assertAgentThreadOpen(this.#context);

    return queueThreadNotification(input, options, {
      activeRun: activeTurnRun(this.#context.turn),
      activeRuntimeInput: activeTurnRuntimeInput(this.#context.turn),
      attachmentStore: this.#context.model.attachmentStore,
      drain: () => drainAgentThreadInputQueue(this.#context),
      emitObserverEvent: (run, event) =>
        this.#context.events.emitObserverEvent(run, event),
      executionHost: this.#context.execution.executionHost,
      inputQueue: this.#context.inputQueue,
      pendingRuntimeInputs: this.#context.pendingRuntimeInputs,
      threadKey: this.#context.threadKey,
      throwIfTerminal: () => assertAgentThreadOpen(this.#context),
    });
  }

  async steer(input: AgentInput): Promise<AgentTurn> {
    assertAgentThreadOpen(this.#context);

    const runtimeInput = activeTurnRuntimeInput(this.#context.turn);
    const run = activeTurnRun(this.#context.turn);
    if (!(runtimeInput && run)) {
      return this.send(input);
    }

    await addDurableSteeringInput({
      executionHost: this.#context.execution.executionHost,
      attachmentStore: this.#context.model.attachmentStore,
      input,
      runtimeInput,
      threadKey: this.#context.threadKey,
    });
    return run;
  }

  compact(input: ThreadCompactionInput): Promise<boolean>;
  compact(
    options?: CompactionSummaryOptions
  ): Promise<ManualThreadCompactionResult>;
  async compact(
    input?: CompactionSummaryOptions | ThreadCompactionInput
  ): Promise<boolean | ManualThreadCompactionResult> {
    return await compactAgentThread(this.#context, input);
  }

  events(options?: ThreadEventReadOptions): AsyncIterable<StoredThreadEvent> {
    return readThreadEvents(
      this.#context.execution,
      this.#context.threadKey,
      options
    );
  }

  interrupt(): void {
    turnAbort(this.#context.turn)?.abort();
  }

  delete(): Promise<void> {
    const terminal = this.#context.terminal;
    const current = terminal.state;
    if (current.tag === "deleting" || current.tag === "deleted") {
      return current.deletePromise;
    }

    const killPromise =
      current.tag === "killed" ? current.killPromise : this.kill();
    const settled = deferred();
    const deletePromise = settled.promise;
    const remove = async (): Promise<void> => {
      await killPromise;
      const drainState = this.#context.drain.state;
      if (drainState.tag === "draining") {
        await drainState.promise;
      }
      const afterKill = terminal.state;
      if (afterKill.tag === "deleting" || afterKill.tag === "deleted") {
        return await afterKill.deletePromise;
      }
      if (afterKill.tag !== "killed") {
        throw new Error("Thread kill did not reach a terminal state.");
      }
      terminal.to({ tag: "deleting", deletePromise, killPromise });
      try {
        await this.#deleteThread();
        terminal.toIf("deleting", {
          tag: "deleted",
          deletePromise,
          killPromise,
        });
      } catch (error) {
        // The durable delete can be retried without repeating the successful
        // kill teardown.
        terminal.toIf("deleting", { tag: "killed", killPromise });
        throw error;
      }
    };
    remove().then(settled.resolve, settled.reject);
    return deletePromise;
  }

  async dispose(): Promise<void> {
    const kill = this.kill();
    try {
      const drainState = this.#context.drain.state;
      if (drainState.tag === "draining") {
        await drainState.promise;
      }
    } finally {
      await kill;
      await this.#shutdown();
    }
  }

  kill(): Promise<void> {
    return killAgentThread(this.#context);
  }

  async #deleteThread(): Promise<void> {
    await this.#shutdown();
    const hostStore = this.#context.execution.executionHost?.store;
    const deleteThread = hostStore?.deleteThread?.bind(hostStore);
    await this.#context.state.delete(
      deleteThread
        ? async () => await deleteThread(this.#context.threadKey)
        : undefined
    );
  }

  async #shutdown(): Promise<void> {
    const lifecycle = this.#context.lifecycle;
    const current = lifecycle.state;
    if (current.tag === "stopping") {
      return await current.promise;
    }
    if (current.tag === "created" || current.tag === "stopped") {
      return;
    }

    // A failed start means there is nothing to stop; shutdown (and thus
    // delete/dispose) must still complete instead of replaying the load
    // failure.
    const startSettled =
      current.tag === "starting"
        ? current.promise.catch(() => undefined)
        : Promise.resolve();
    const stop = deferred();
    lifecycle.to({ tag: "stopping", promise: stop.promise });
    // Shutdown is only reachable through kill/delete/dispose.
    assertThreadMachineInvariants(this.#context);
    startSettled.then(() => {
      lifecycle.toIf("stopping", { tag: "stopped" });
      stop.resolve();
    });
    return await stop.promise;
  }
}
