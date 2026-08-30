import { describe, expect, it } from "vitest";
import type {
  AgentHost,
  HostStoreTransaction,
  TurnStore,
} from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { ThreadState } from "../state/thread-state";
import { startThreadExecutionRun } from "./execution";

describe("legacy TurnStore compatibility", () => {
  it("completes an ordinary run with an external store that has no transition method", async () => {
    // Given: a host backed by the pre-transition TurnStore surface.
    const host = legacyTurnStoreHost(createInMemoryHost());
    const state = new ThreadState({
      key: "legacy-store-thread",
      store: host.store.threads,
    });
    const execution = await startThreadExecutionRun({
      executionHost: host,
      state,
      threadKey: "legacy-store-thread",
      turnId: "legacy-store-turn",
    });
    if (execution === undefined) {
      throw new Error("Expected a durable execution run.");
    }

    // When: an ordinary user turn runs to completion.
    const completion = execution.complete("completed");

    // Then: compatibility preserves successful terminal completion.
    await expect(completion).resolves.toBeUndefined();
    await expect(host.store.turns.get(execution.runId)).resolves.toMatchObject({
      status: "completed",
    });
  });
});

function legacyTurnStoreHost(base: AgentHost): AgentHost {
  const store = new Proxy(base.store, {
    get(target, property) {
      if (property === "turns") {
        return legacyTurnStore(target.turns);
      }
      if (property === "transaction") {
        return async <T>(
          operation: (transaction: HostStoreTransaction) => Promise<T>
        ): Promise<T> =>
          await target.transaction(
            async (transaction) =>
              await operation(transactionWithoutTransition(transaction))
          );
      }
      return Reflect.get(target, property);
    },
  });
  return new Proxy(base, {
    get(target, property) {
      return property === "store" ? store : Reflect.get(target, property);
    },
  });
}

function transactionWithoutTransition(
  transaction: HostStoreTransaction
): HostStoreTransaction {
  return new Proxy(transaction, {
    get(target, property) {
      return property === "turns"
        ? legacyTurnStore(target.turns)
        : Reflect.get(target, property);
    },
  });
}

function legacyTurnStore(turns: TurnStore) {
  return {
    claim: turns.claim.bind(turns),
    create: turns.create.bind(turns),
    get: turns.get.bind(turns),
    getByDedupeKey: turns.getByDedupeKey.bind(turns),
    listByParentRunId: turns.listByParentRunId.bind(turns),
    update: turns.update.bind(turns),
  };
}
