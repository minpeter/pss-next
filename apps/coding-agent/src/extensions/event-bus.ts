import { CodingAgentExtensionError } from "./error";
import { assertJsonValue } from "./json-state";
import { raceWithExtensionTimeout } from "./operation-timeout";
import type { ExtensionJsonValue } from "./types";

const EVENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9:._-]*$/;
const MAX_EVENT_TYPE_LENGTH = 128;
/** Event namespaces only the host may publish. */
const HOST_EVENT_PREFIXES = ["host:", "provider:"] as const;

export type ExtensionBusHandler = (
  payload: ExtensionJsonValue | undefined
) => Promise<void> | void;

interface BusSubscription {
  readonly extensionId: string;
  readonly handler: ExtensionBusHandler;
  readonly type: string;
}

/**
 * Shared publish/subscribe bus for one extension host.
 *
 * Payloads are JSON values cloned per delivery so subscribers cannot mutate
 * shared state. Handlers run under the host timeout/abort boundary; failures
 * are attributed to the subscribing extension and reported without
 * interrupting other subscribers or the publisher.
 */
export class ExtensionHostEventBus {
  #disposed = false;
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #onHandlerError: (error: CodingAgentExtensionError) => void;
  readonly #signal: AbortSignal;
  readonly #subscriptions = new Set<BusSubscription>();
  readonly #timeoutMs: number;

  constructor(options: {
    readonly onHandlerError?: (error: CodingAgentExtensionError) => void;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }) {
    this.#onHandlerError =
      options.onHandlerError ??
      ((error) => {
        process.stderr.write(`${error.message}\n`);
      });
    this.#signal = options.signal;
    this.#timeoutMs = options.timeoutMs;
  }

  /** Publish from an extension; host-reserved namespaces are rejected. */
  emitFromExtension(
    extensionId: string,
    type: string,
    payload: ExtensionJsonValue | undefined
  ): void {
    assertEventType(type);
    for (const prefix of HOST_EVENT_PREFIXES) {
      if (type.startsWith(prefix)) {
        throw new TypeError(
          `Extension event type "${type}" uses the reserved "${prefix}" namespace`
        );
      }
    }
    this.#publish(`extension:${extensionId}`, type, payload);
  }

  /** Publish a host-originated event such as provider observations. */
  emitFromHost(type: string, payload: ExtensionJsonValue | undefined): void {
    assertEventType(type);
    this.#publish("host", type, payload);
  }

  subscribe(
    extensionId: string,
    type: string,
    handler: ExtensionBusHandler
  ): () => void {
    if (this.#disposed) {
      throw new Error("Coding agent extension host is disposed");
    }
    assertEventType(type);
    if (typeof handler !== "function") {
      throw new TypeError(
        `Extension event handler for "${type}" must be a function`
      );
    }
    const subscription: BusSubscription = { extensionId, handler, type };
    this.#subscriptions.add(subscription);
    return () => {
      this.#subscriptions.delete(subscription);
    };
  }

  /**
   * Stop accepting publications and drain in-flight deliveries. Each
   * delivery is bounded by the host timeout, so draining is bounded too;
   * handlers that outlive their timeout are detached and their state
   * writes are rejected by the post-disposal revocation.
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#subscriptions.clear();
    await Promise.allSettled([...this.#inFlight]);
  }

  #publish(
    _source: string,
    type: string,
    payload: ExtensionJsonValue | undefined
  ): void {
    if (this.#disposed || this.#signal.aborted) {
      return;
    }
    if (payload !== undefined) {
      assertJsonValue(payload, `Extension event "${type}" payload`);
    }
    // Snapshot at publication time so publisher mutations after emit() are
    // never observed and cloning failures surface to the publisher.
    const snapshot =
      payload === undefined ? undefined : structuredClone(payload);
    for (const subscription of [...this.#subscriptions]) {
      if (subscription.type !== type) {
        continue;
      }
      this.#deliver(subscription, snapshot);
    }
  }

  #deliver(
    subscription: BusSubscription,
    payload: ExtensionJsonValue | undefined
  ): void {
    const task = (async () => {
      // Defer past the publisher so synchronous handler work cannot block
      // emit(); the timeout timer below is installed before this runs.
      await Promise.resolve();
      // The host may have been disposed between emit() and this microtask;
      // never run handlers against torn-down resources.
      if (
        this.#disposed ||
        this.#signal.aborted ||
        !this.#subscriptions.has(subscription)
      ) {
        return;
      }
      await subscription.handler(
        payload === undefined ? undefined : structuredClone(payload)
      );
    })();
    const delivery = raceWithExtensionTimeout(
      subscription.extensionId,
      "event",
      task,
      {
        signal: this.#signal,
        timeoutMs: this.#timeoutMs,
      }
    ).catch((error: unknown) => {
      this.#onHandlerError(
        error instanceof CodingAgentExtensionError
          ? error
          : new CodingAgentExtensionError(
              subscription.extensionId,
              "event",
              error
            )
      );
    });
    this.#inFlight.add(delivery);
    delivery.finally(() => {
      this.#inFlight.delete(delivery);
    });
  }
}

function assertEventType(type: string): void {
  if (
    typeof type !== "string" ||
    type.length === 0 ||
    type.length > MAX_EVENT_TYPE_LENGTH ||
    !EVENT_TYPE_PATTERN.test(type)
  ) {
    throw new TypeError(
      `Invalid extension event type "${String(type)}": use lowercase letters, digits, ":", ".", "_", or "-"`
    );
  }
}
