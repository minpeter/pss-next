import type {
  StoredThreadEvent,
  ThreadEventReadOptions,
} from "../../execution/host/types";
import { deferred } from "../../internal/deferred";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { AgentInput, UserInput } from "../input/input";
import { type AgentTurn, BufferedAgentTurn } from "../protocol/turn";
import type { ThreadExecutionOptions } from "../runtime/execution";
import type { NotifyOptions } from "../runtime/notification";
import { queueThreadNotification } from "../runtime/notification";
import { readThreadEvents } from "../runtime/thread-event-replay";
import {
  reserveThreadInputAdmission,
  type ThreadInputAdmissionReservation,
} from "../runtime/thread-input-admission-coordinator";
import { threadKilledError } from "../state/thread-errors";
import type {
  ThreadCompactionInput,
  ThreadPersistenceOptions,
} from "../state/thread-state";
import {
  type AgentThreadContext,
  createAgentThreadContext,
} from "./agent-thread-context";
import { drainAgentThreadInputQueue } from "./agent-thread-drain";
import { killAgentThread } from "./agent-thread-kill";
import {
  activeTurnRun,
  activeTurnRuntimeInput,
  assertThreadMachineInvariants,
  turnAbort,
} from "./agent-thread-machines";
import { recoverThreadDurableInputClaims } from "./durable-queue-claims";
import { admitThreadSendInput } from "./durable-queue-send";
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
    return await this.#queueTurnInput(input, "send");
  }

  /** Queue a durable user turn that starts only after the active turn ends. */
  async followUp(input: AgentInput): Promise<AgentTurn> {
    return await this.#queueTurnInput(input, "follow-up");
  }

  overlay(input: AgentInput): this {
    this.#assertOpen();

    this.#context.pendingOverlays.push(createOverlayRuntimeInput(input));
    return this;
  }

  async notify(
    input: AgentInput | UserInput,
    options: NotifyOptions = {}
  ): Promise<AgentTurn> {
    this.#assertOpen();

    await this.#ensureStarted();
    await this.#recoverDurableInputClaims();

    this.#assertOpen();

    return queueThreadNotification(input, options, {
      activeRun: activeTurnRun(this.#context.turn),
      activeRuntimeInput: activeTurnRuntimeInput(this.#context.turn),
      attachmentStore: this.#context.model.attachmentStore,
      drain: () => this.#drainInputQueue(),
      emitObserverEvent: (run, event) =>
        this.#context.events.emitObserverEvent(run, event),
      executionHost: this.#context.execution.executionHost,
      inputQueue: this.#context.inputQueue,
      pendingRuntimeInputs: this.#context.pendingRuntimeInputs,
      threadKey: this.#context.threadKey,
      throwIfTerminal: () => this.#assertOpen(),
    });
  }

  async steer(input: AgentInput): Promise<AgentTurn> {
    this.#assertOpen();

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

  async compact(input: ThreadCompactionInput): Promise<void> {
    this.#assertOpen();

    await this.#ensureStarted();
    await this.#recoverDurableInputClaims();

    this.#assertOpen();

    await this.#context.events.compact(this.#context.state, input);
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

    const killPromise = this.kill();
    const settled = deferred();
    const deletePromise = settled.promise;
    // Transition before wiring the continuation so the machine state never
    // depends on microtask scheduling.
    terminal.to({ tag: "deleting", deletePromise, killPromise });
    killPromise
      .then(() => this.#deleteThread())
      .then(
        () => {
          terminal.toIf("deleting", {
            tag: "deleted",
            deletePromise,
            killPromise,
          });
          settled.resolve();
        },
        (error: unknown) => {
          // Roll back to `killed` so the delete can be retried.
          terminal.toIf("deleting", { tag: "killed", killPromise });
          settled.reject(error);
        }
      );
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

  async #queueTurnInput(
    input: AgentInput,
    kind: "follow-up" | "send"
  ): Promise<AgentTurn> {
    this.#assertOpen();

    const run = new BufferedAgentTurn();
    const executionHost = this.#context.execution.executionHost;
    const reservation = executionHost
      ? reserveThreadInputAdmission(executionHost, this.#context.threadKey)
      : undefined;
    const loaded = this.#ensureStarted();
    await this.#enqueueInputAdmission(async () => {
      const admit = async (): Promise<void> => {
        await loaded;
        await this.#admitSend(
          input,
          run,
          kind,
          async (operation) => await operation()
        );
      };
      await (reservation ? reservation(admit) : admit());
    });
    return run;
  }

  async #admitSend(
    input: AgentInput,
    run: BufferedAgentTurn,
    kind: "follow-up" | "send",
    reservation?: ThreadInputAdmissionReservation
  ): Promise<void> {
    this.#assertOpen();

    await this.#recoverDurableInputClaims();

    this.#assertOpen();

    // Skip awaiting turn boundaries when the drain loop is running without an
    // active turn: the boundary events would never be acknowledged.
    const idleDrainLoop =
      this.#context.drain.state.tag === "draining" &&
      this.#context.turn.state.tag !== "active";
    await admitThreadSendInput({
      awaitBoundaries: !idleDrainLoop,
      drain: () => this.#drainInputQueue(),
      events: this.#context.events,
      executionHost: this.#context.execution.executionHost,
      attachmentStore: this.#context.model.attachmentStore,
      input,
      inputQueue: this.#context.inputQueue,
      kind,
      pendingOverlays: this.#context.pendingOverlays,
      pendingRuntimeInputs: this.#context.pendingRuntimeInputs,
      reservation,
      run,
      threadKey: this.#context.threadKey,
    });
    this.#assertOpen();
  }

  async #enqueueInputAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#context.inputAdmissionQueue.then(operation, operation);
    this.#context.inputAdmissionQueue = next.then(
      () => undefined,
      () => undefined
    );
    return await next;
  }

  async #recoverDurableInputClaims(): Promise<void> {
    await recoverThreadDurableInputClaims({
      executionHost: this.#context.execution.executionHost,
      state: this.#context.durableInputRecovery,
      threadKey: this.#context.threadKey,
    });
  }

  async #drainInputQueue(): Promise<void> {
    await drainAgentThreadInputQueue(this.#context);
  }

  #assertOpen(): void {
    if (this.#context.terminal.state.tag !== "open") {
      throw threadKilledError();
    }
  }

  #ensureStarted(): Promise<void> {
    const lifecycle = this.#context.lifecycle;
    const current = lifecycle.state;
    if (current.tag === "starting" || current.tag === "stopping") {
      return current.promise;
    }
    if (current.tag !== "created") {
      return Promise.resolve();
    }

    const start = deferred();
    lifecycle.to({ tag: "starting", promise: start.promise });
    this.#context.state.ensureLoaded().then(
      () => {
        lifecycle.toIf("starting", { tag: "started" });
        start.resolve();
      },
      (error: unknown) => {
        // A failed load is retryable: return to `created` so the next call
        // reloads instead of replaying the first failure forever.
        lifecycle.toIf("starting", { tag: "created" });
        start.reject(error);
      }
    );
    return start.promise;
  }

  async #deleteThread(): Promise<void> {
    await this.#shutdown();
    await this.#context.state.delete();
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
