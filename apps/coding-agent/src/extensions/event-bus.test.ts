import { describe, expect, it, vi } from "vitest";
import type { CodingAgentExtensionError } from "./error";
import { ExtensionHostEventBus } from "./event-bus";

const reservedPattern = /reserved "provider:" namespace/u;
const invalidTypePattern = /Invalid extension event type/u;
const disposedPattern = /disposed/u;
const handlerFunctionPattern = /must be a function/u;
const payloadPattern = /payload/u;

function createBus(options?: {
  readonly onHandlerError?: (error: CodingAgentExtensionError) => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): ExtensionHostEventBus {
  return new ExtensionHostEventBus({
    ...(options?.onHandlerError === undefined
      ? {}
      : { onHandlerError: options.onHandlerError }),
    signal: options?.signal ?? new AbortController().signal,
    timeoutMs: options?.timeoutMs ?? 50,
  });
}

async function settle(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

describe("extension host event bus", () => {
  it("delivers cloned payloads to matching subscribers only", async () => {
    // Given
    const bus = createBus();
    const received: unknown[] = [];
    const other: unknown[] = [];
    bus.subscribe("listener", "metrics:sample", (payload) => {
      received.push(payload);
    });
    bus.subscribe("listener", "different", (payload) => {
      other.push(payload);
    });
    const payload = { nested: { count: 1 } };

    // When
    bus.emitFromExtension("emitter", "metrics:sample", payload);
    const receivedSynchronously = received.length;
    await settle();

    // Then — delivery is deferred so handlers cannot block the publisher.
    expect(receivedSynchronously).toBe(0);
    expect(received).toEqual([{ nested: { count: 1 } }]);
    expect(received[0]).not.toBe(payload);
    expect(other).toEqual([]);
  });

  it("supports unsubscribe and dispose", async () => {
    // Given
    const bus = createBus();
    const received: unknown[] = [];
    const unsubscribe = bus.subscribe("listener", "topic", (payload) => {
      received.push(payload);
    });

    // When
    unsubscribe();
    bus.emitFromExtension("emitter", "topic", 1);
    await settle();
    bus.dispose();

    // Then
    expect(received).toEqual([]);
    expect(() => bus.subscribe("listener", "topic", () => undefined)).toThrow(
      disposedPattern
    );
    expect(() => bus.emitFromExtension("emitter", "topic", 2)).not.toThrow();
  });

  it("rejects reserved namespaces for extensions but allows the host", async () => {
    // Given
    const bus = createBus();
    const received: unknown[] = [];
    bus.subscribe("listener", "provider:response", (payload) => {
      received.push(payload);
    });

    // When / Then
    expect(() =>
      bus.emitFromExtension("emitter", "provider:response", { status: 200 })
    ).toThrow(reservedPattern);
    bus.emitFromHost("provider:response", { status: 200 });
    await settle();
    expect(received).toEqual([{ status: 200 }]);
  });

  it("rejects invalid event types and non-function handlers", () => {
    // Given
    const bus = createBus();

    // When / Then
    expect(() => bus.emitFromExtension("emitter", "", 1)).toThrow(
      invalidTypePattern
    );
    expect(() => bus.emitFromExtension("emitter", "Bad Type", 1)).toThrow(
      invalidTypePattern
    );
    expect(() =>
      bus.subscribe(
        "listener",
        "topic",
        "not-a-function" as unknown as () => void
      )
    ).toThrow(handlerFunctionPattern);
  });

  it("attributes handler failures without breaking other subscribers", async () => {
    // Given
    const failures: CodingAgentExtensionError[] = [];
    const bus = createBus({ onHandlerError: (error) => failures.push(error) });
    const received: unknown[] = [];
    bus.subscribe("broken", "topic", () => {
      throw new Error("handler exploded");
    });
    bus.subscribe("healthy", "topic", (payload) => {
      received.push(payload);
    });

    // When
    bus.emitFromExtension("emitter", "topic", "ping");
    await settle();

    // Then
    expect(received).toEqual(["ping"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.extensionId).toBe("broken");
  });

  it("times out never-settling handlers under the host budget", async () => {
    // Given
    vi.useFakeTimers();
    try {
      const failures: CodingAgentExtensionError[] = [];
      const bus = createBus({
        onHandlerError: (error) => failures.push(error),
        timeoutMs: 20,
      });
      bus.subscribe("hang", "topic", () => new Promise<void>(() => undefined));

      // When
      bus.emitFromExtension("emitter", "topic", 1);
      await vi.advanceTimersByTimeAsync(25);

      // Then
      expect(failures).toHaveLength(1);
      expect(failures[0]?.extensionId).toBe("hang");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects non-JSON payloads", () => {
    // Given
    const bus = createBus();

    // When / Then
    expect(() =>
      bus.emitFromExtension("emitter", "topic", {
        fn: () => undefined,
      } as never)
    ).toThrow(payloadPattern);
  });
});
