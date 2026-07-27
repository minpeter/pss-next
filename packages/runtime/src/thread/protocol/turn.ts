import { Fsm } from "../../fsm";
import type { AgentEvent } from "./events";

export interface AgentTurn {
  events(): AsyncIterable<AgentEvent>;
  readonly runId?: string;
}

interface QueuedEvent {
  readonly ack?: () => void;
  readonly event: AgentEvent;
}

interface NextWaiter {
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: IteratorResult<AgentEvent>) => void;
}

/** Producer side: whether the turn still accepts events. */
type TurnChannelState =
  | { readonly tag: "open" }
  | { readonly tag: "closed"; readonly error: unknown };

/**
 * Consumer side of the event iterator.
 *
 * - `unconsumed`: `events()` has not been called yet.
 * - `idle`: consumer exists but has no outstanding request.
 * - `waiting`: a `next()` call is parked until an event arrives.
 * - `delivering`: a result resolved this tick; same-tick `next()` prefetch is
 *   rejected until the guard microtask expires.
 * - `delivered`: the result is with the consumer; a boundary `ack` (if any)
 *   settles when the consumer asks for the next event.
 */
type TurnConsumerState =
  | { readonly tag: "unconsumed" }
  | { readonly tag: "idle" }
  | { readonly tag: "waiting"; readonly waiter: NextWaiter }
  | { readonly tag: "delivering"; readonly ack?: () => void }
  | { readonly tag: "delivered"; readonly ack?: () => void };

const createChannelMachine = () =>
  new Fsm<TurnChannelState>({
    initial: { tag: "open" },
    name: "agent-turn-channel",
    transitions: {
      open: ["closed"],
      closed: [],
    },
  });

const createConsumerMachine = () =>
  new Fsm<TurnConsumerState>({
    initial: { tag: "unconsumed" },
    name: "agent-turn-consumer",
    transitions: {
      unconsumed: ["idle"],
      idle: ["waiting", "delivering"],
      waiting: ["delivering", "idle"],
      // `delivering -> delivering` drops the ack when close() settles it
      // early while the same-tick prefetch guard is still armed.
      delivering: ["delivering", "delivered"],
      // A delivered result only leaves through `#settlePendingAck` (the
      // consumer asking for the next event, or close), which parks at idle.
      delivered: ["idle"],
    },
  });

export class BufferedAgentTurn implements AgentTurn {
  readonly #channel = createChannelMachine();
  readonly #consumer = createConsumerMachine();
  readonly #events: QueuedEvent[] = [];
  #runId: string | undefined;

  constructor(runId?: string) {
    this.#runId = runId;
  }

  get runId(): string | undefined {
    return this.#runId;
  }

  bindRunId(runId: string): void {
    if (this.#runId === undefined) {
      this.#runId = runId;
      return;
    }
    if (this.#runId !== runId) {
      throw new Error(`AgentTurn is already bound to run id ${this.#runId}`);
    }
  }

  emit(event: AgentEvent): void {
    if (this.#channel.state.tag === "closed") {
      return;
    }

    this.#enqueue({ event: structuredClone(event) });
  }

  emitBoundary(event: AgentEvent): Promise<void> {
    if (this.#channel.state.tag === "closed") {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.#enqueue({ ack: resolve, event: structuredClone(event) });
    });
  }

  close(error?: unknown): void {
    if (this.#channel.state.tag === "closed") {
      return;
    }

    this.#channel.to({ tag: "closed", error });
    this.#settlePendingAck();
    this.#settleQueuedAcks();

    const consumer = this.#consumer.state;
    if (consumer.tag !== "waiting") {
      return;
    }

    this.#consumer.to({ tag: "idle" });
    if (error) {
      consumer.waiter.reject(error);
      return;
    }
    consumer.waiter.resolve({ done: true, value: undefined });
  }

  events(): AsyncIterable<AgentEvent> {
    if (this.#consumer.state.tag !== "unconsumed") {
      throw new Error("AgentTurn.events() can only be consumed once");
    }
    this.#consumer.to({ tag: "idle" });

    const iterator: AsyncIterableIterator<AgentEvent> = {
      next: () => this.#next(),
      return: () => {
        this.#cancel();
        return Promise.resolve({ done: true, value: undefined });
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }

  #cancel(): void {
    this.#settleQueuedAcks();
    this.#events.length = 0;
    this.close();
  }

  #enqueue(event: QueuedEvent): void {
    const consumer = this.#consumer.state;
    if (consumer.tag === "waiting") {
      this.#deliver(consumer.waiter.resolve, event);
      return;
    }

    this.#events.push(event);
  }

  #next(): Promise<IteratorResult<AgentEvent>> {
    const consumer = this.#consumer.state;
    if (consumer.tag === "delivering" || consumer.tag === "waiting") {
      return Promise.reject(
        new Error("AgentTurn.events() does not allow concurrent next() calls")
      );
    }

    this.#settlePendingAck();

    const event = this.#events.shift();
    if (event) {
      return new Promise((resolve) => this.#deliver(resolve, event));
    }

    const channel = this.#channel.state;
    if (channel.tag === "closed") {
      if (channel.error) {
        return Promise.reject(channel.error);
      }
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise((resolve, reject) => {
      this.#consumer.to({ tag: "waiting", waiter: { reject, resolve } });
    });
  }

  #deliver(
    resolve: (value: IteratorResult<AgentEvent>) => void,
    { ack, event }: QueuedEvent
  ): void {
    this.#consumer.to({ tag: "delivering", ack });
    queueMicrotask(() => {
      const current = this.#consumer.state;
      if (current.tag === "delivering") {
        this.#consumer.to({ tag: "delivered", ack: current.ack });
      }
    });
    resolve({ done: false, value: event });
  }

  #settlePendingAck(): void {
    const consumer = this.#consumer.state;
    if (consumer.tag === "delivered") {
      this.#consumer.to({ tag: "idle" });
      consumer.ack?.();
      return;
    }
    if (consumer.tag === "delivering" && consumer.ack !== undefined) {
      // Keep the same-tick prefetch guard, but the ack settles now.
      this.#consumer.to({ tag: "delivering" });
      consumer.ack();
    }
  }

  #settleQueuedAcks(): void {
    for (const event of this.#events) {
      event.ack?.();
    }
  }
}
