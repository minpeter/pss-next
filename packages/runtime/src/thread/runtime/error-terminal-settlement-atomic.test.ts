import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { dispatchAgentNotification } from "../../execution/dispatch/notification-dispatch";
import type {
  AgentHost,
  HostStoreTransaction,
  TurnRecord,
} from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { createCallbackModel, userText } from "../../testing/test-fixtures";
import { collect } from "../handle/test-support";
import type { StoredThread } from "../store/types";

class ModelFailure extends Error {
  readonly name = "ModelFailure";
}

class TurnErrorAppendFailure extends Error {
  readonly name = "TurnErrorAppendFailure";
}

interface PreRecoveryState {
  readonly run: TurnRecord;
  readonly thread: StoredThread;
}

describe("error terminal settlement atomicity", () => {
  it("keeps the leased run, thread, and event log unchanged when turn-error append fails", async () => {
    // Given: a real resumed Agent turn whose model captures its pre-recovery state.
    const base = createInMemoryHost();
    const host = withFailingTurnErrorAppend(base);
    const threadKey = "atomic-error-settlement";
    const namespace = "atomic-error-agent";
    let runId = "";
    let beforeRecovery: PreRecoveryState | undefined;
    const agent = new Agent({
      host,
      model: createCallbackModel(async () => {
        const run = await base.store.turns.get(runId);
        const thread = await base.store.threads.load(threadKey);
        if (!(run && thread)) {
          throw new TypeError("Expected persisted pre-recovery state.");
        }
        beforeRecovery = { run, thread };
        throw new ModelFailure();
      }),
      namespace,
    });
    const dispatched = await dispatchAgentNotification({
      host,
      idempotencyKey: "atomic-error-notification",
      input: userText("fail during resumed work"),
      namespace,
      threadKey,
    });
    runId = dispatched.runId;

    // When: durable error settlement reaches the failing event append.
    const turn = await agent.resume(runId);
    if (!turn) {
      throw new TypeError("Expected the notification turn to resume.");
    }
    const settlement = collect(turn);
    await expect(settlement).rejects.toBeInstanceOf(TurnErrorAppendFailure);
    if (!beforeRecovery) {
      throw new TypeError("Expected the model to capture pre-recovery state.");
    }

    // Then: the failure propagates and the entire settlement remains atomic.
    expect(beforeRecovery.run.status).toBe("running");
    expect(beforeRecovery.run.lease).toBeDefined();
    expect({
      run: await base.store.turns.get(runId),
      thread: await base.store.threads.load(threadKey),
      turnErrorCount: await durableTurnErrorCount(base, threadKey),
    }).toEqual({
      run: beforeRecovery.run,
      thread: beforeRecovery.thread,
      turnErrorCount: 0,
    });
  });
});

function withFailingTurnErrorAppend(base: AgentHost): AgentHost {
  return {
    ...base,
    store: {
      ...base.store,
      transaction: <T>(
        fn: (tx: HostStoreTransaction) => Promise<T>
      ): Promise<T> =>
        base.store.transaction((tx) => fn(failTurnErrorAppend(tx))),
    },
  };
}

function failTurnErrorAppend(tx: HostStoreTransaction): HostStoreTransaction {
  const threadEvents = tx.threadEvents;
  if (!threadEvents) {
    throw new TypeError("Expected transactional thread events.");
  }
  return {
    ...tx,
    threadEvents: {
      append: (threadKey, event) => {
        if (event.type === "turn-error") {
          throw new TurnErrorAppendFailure();
        }
        return threadEvents.append(threadKey, event);
      },
      read: (threadKey, options) => threadEvents.read(threadKey, options),
    },
  };
}

async function durableTurnErrorCount(
  host: ReturnType<typeof createInMemoryHost>,
  threadKey: string
): Promise<number> {
  let count = 0;
  for await (const record of host.store.threadEvents.read(threadKey)) {
    if (record.event.type === "turn-error") {
      count += 1;
    }
  }
  return count;
}
