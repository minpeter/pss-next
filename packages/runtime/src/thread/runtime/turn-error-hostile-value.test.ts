import { describe, expect, it } from "vitest";
import { createInMemoryHost, MemoryThreadStore } from "../../platform/memory";
import { createRuntimeInputState } from "../input/runtime-input";
import type { AgentEvent } from "../protocol/events";
import { BufferedAgentTurn } from "../protocol/turn";
import { ThreadState } from "../state/thread-state";
import {
  emitTurnErrorAfterRecovery,
  recoverTurnProcessingError,
} from "./turn-error";

const SAFE_UNKNOWN_EVENT = {
  error: { category: "unknown", version: 1 },
  message: "The request failed.",
  type: "turn-error",
} as const;

describe("hostile turn error recovery", () => {
  it.each(["getter", "call"] as const)(
    "persists and emits stable output when non-Error toString %s throws",
    async (failureKind) => {
      // Given
      const host = createInMemoryHost();
      const durableEvents: AgentEvent[] = [];
      const runtimeInput = createRuntimeInputState([]);
      const run = new BufferedAgentTurn();
      const iterator = run.events()[Symbol.asyncIterator]();
      const emitted = iterator.next();
      const hostileError =
        failureKind === "getter"
          ? Object.defineProperty({}, "toString", {
              get() {
                throw new Error("TO_STRING_SECRET");
              },
            })
          : {
              toString() {
                throw new Error("TO_STRING_SECRET");
              },
            };

      // When
      await recoverTurnProcessingError({
        durableEvents,
        error: hostileError,
        executionHost: host,
        historySnapshot: [],
        recordEvent: (event) => {
          durableEvents.push(event);
        },
        run,
        runtimeInput,
        state: new ThreadState({
          key: "hostile-string-conversion",
          store: host.store.threads,
        }),
        threadKey: "hostile-string-conversion",
      });

      // Then
      const persisted: AgentEvent[] = [];
      const threadEvents = host.store.threadEvents;
      if (!threadEvents) {
        throw new Error("expected durable thread event log");
      }
      for await (const record of threadEvents.read(
        "hostile-string-conversion"
      )) {
        persisted.push(record.event);
      }
      const emittedEvent = (await emitted).value;
      expect(persisted).toEqual([SAFE_UNKNOWN_EVENT]);
      expect(emittedEvent).toEqual(SAFE_UNKNOWN_EVENT);
      expect(JSON.stringify({ emittedEvent, persisted })).not.toContain(
        "TO_STRING_SECRET"
      );
      expect(runtimeInput.closedReason).toBe("turn-error");
      await iterator.return?.();
    }
  );

  it("persists and emits stable output when conflict detection traps", async () => {
    // Given
    const persisted: AgentEvent[] = [];
    const runtimeInput = createRuntimeInputState([]);
    const run = new BufferedAgentTurn();
    const iterator = run.events()[Symbol.asyncIterator]();
    const emitted = iterator.next();
    const hostileError = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("PROTOTYPE_SECRET");
        },
      }
    );

    // When
    await emitTurnErrorAfterRecovery({
      error: hostileError,
      historySnapshot: [],
      persistEvent: (event) => {
        persisted.push(event);
        return Promise.resolve();
      },
      run,
      runtimeInput,
      state: new ThreadState({
        key: "hostile-conflict-detection",
        store: new MemoryThreadStore(),
      }),
    });

    // Then
    const emittedEvent = (await emitted).value;
    expect(persisted).toEqual([SAFE_UNKNOWN_EVENT]);
    expect(emittedEvent).toEqual(SAFE_UNKNOWN_EVENT);
    expect(JSON.stringify({ emittedEvent, persisted })).not.toContain(
      "PROTOTYPE_SECRET"
    );
    expect(runtimeInput.closedReason).toBe("turn-error");
    await iterator.return?.();
  });
});
