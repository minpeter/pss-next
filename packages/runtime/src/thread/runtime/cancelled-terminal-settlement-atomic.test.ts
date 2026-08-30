import { describe, expect, it } from "vitest";
import type {
  AgentHost,
  HostStoreTransaction,
} from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { createRuntimeInputState } from "../input/runtime-input";
import { BufferedAgentTurn, bindTurnExecutionRun } from "../protocol/turn";
import { ThreadState } from "../state/thread-state";
import { startThreadExecutionRun } from "./execution";
import { closeKilledRuntimeInputs } from "./kill";
import {
  commitTerminalThreadStateAndEvents,
  createDurableThreadEventRecorder,
} from "./thread-event-log";

class TurnAbortAppendFailure extends Error {
  readonly name = "TurnAbortAppendFailure";
}

describe("cancelled terminal settlement atomicity", () => {
  it("rolls back cancellation with thread state when turn-abort persistence fails", async () => {
    // Given: owner A is running and local kill begins its active teardown.
    const base = createInMemoryHost();
    const host = withFailingTurnAbortAppend(base);
    const runId = "atomic-cancellation";
    const threadKey = "atomic-cancellation-thread";
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey,
    });
    const claimed = await host.store.turns.claim(runId, {
      attempt: 1,
      leaseId: "owner-a",
      leaseMs: 100,
      nowMs: 0,
    });
    if (!claimed.ok) {
      throw new TypeError("Expected owner A to claim the run.");
    }
    const state = new ThreadState({
      key: threadKey,
      store: host.store.threads,
    });
    const execution = await startThreadExecutionRun({
      executionHost: host,
      executionRun: {
        kind: "user-turn",
        leaseId: "owner-a",
        runId,
      },
      state,
      threadKey,
      turnId: "unused",
    });
    if (!execution) {
      throw new TypeError("Expected a durable execution.");
    }
    const running = await base.store.turns.get(runId);
    const run = new BufferedAgentTurn();
    bindTurnExecutionRun(run, runId, "owner-a");

    // When: local teardown closes the caller, then atomic abort settlement
    // fails while appending its durable terminal event.
    await closeKilledRuntimeInputs({
      activeRuntimeInput: createRuntimeInputState([]),
      executionHost: host,
      inputQueue: [],
      message: "killed",
      runToClose: run,
      threadKey,
    });
    const { buffer, record } = createDurableThreadEventRecorder();
    record({ type: "turn-abort" });
    const settlement = commitTerminalThreadStateAndEvents({
      buffer,
      executionHost: host,
      executionRun: execution,
      state,
      status: "cancelled",
      threadKey,
    });

    // Then: run, thread state, and event log all remain pre-settlement.
    await expect(settlement).rejects.toBeInstanceOf(TurnAbortAppendFailure);
    await expect(base.store.turns.get(runId)).resolves.toEqual(running);
    await expect(base.store.threads.load(threadKey)).resolves.toBeNull();
    const events: unknown[] = [];
    for await (const event of base.store.threadEvents.read(threadKey)) {
      events.push(event);
    }
    expect(events).toEqual([]);
    expect(buffer).toEqual([{ type: "turn-abort" }]);
  });
});

function withFailingTurnAbortAppend(base: AgentHost): AgentHost {
  return {
    ...base,
    store: {
      ...base.store,
      transaction: <T>(
        operation: (tx: HostStoreTransaction) => Promise<T>
      ): Promise<T> =>
        base.store.transaction((tx) => operation(failTurnAbortAppend(tx))),
    },
  };
}

function failTurnAbortAppend(tx: HostStoreTransaction): HostStoreTransaction {
  const threadEvents = tx.threadEvents;
  if (!threadEvents) {
    throw new TypeError("Expected transactional thread events.");
  }
  return {
    ...tx,
    threadEvents: {
      append: (threadKey, event) => {
        if (event.type === "turn-abort") {
          throw new TurnAbortAppendFailure();
        }
        return threadEvents.append(threadKey, event);
      },
      read: (threadKey, options) => threadEvents.read(threadKey, options),
    },
  };
}
