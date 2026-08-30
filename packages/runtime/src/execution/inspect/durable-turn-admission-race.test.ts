import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { transitionTurn } from "../host/turn-status";
import { inspectDurableTurn } from "./durable-turn";

describe("durable turn admission race inspection", () => {
  it("cancels a precreated run when dispose races with admission", async () => {
    const host = createInMemoryHost();
    const createStarted = createDeferred();
    const allowCreate = createDeferred();
    const originalTransaction = host.store.transaction.bind(host.store);
    let precreatedRunId: string | undefined;
    vi.spyOn(host.store, "transaction").mockImplementation((callback) =>
      originalTransaction((transaction) =>
        callback({
          ...transaction,
          turns: {
            claim: (targetRunId, options) =>
              transaction.turns.claim(targetRunId, options),
            create: async (record) => {
              if (record.kind === "user-turn" && record.status === "queued") {
                precreatedRunId = record.runId;
                createStarted.resolve();
                await allowCreate.promise;
              }
              return await transaction.turns.create(record);
            },
            get: (targetRunId) => transaction.turns.get(targetRunId),
            getByDedupeKey: (dedupeKey) =>
              transaction.turns.getByDedupeKey(dedupeKey),
            listByParentRunId: (parentRunId) =>
              transaction.turns.listByParentRunId(parentRunId),
            transition: (runId, expected, update) =>
              transitionTurn(transaction.turns, { expected, runId, update }),
            update: (record) => transaction.turns.update(record),
          },
        })
      )
    );
    const agent = new Agent({
      host,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("not reached")])
      ),
    });
    const thread = agent.thread("lifecycle-admission-race");

    const sending = thread.send("race disposal");
    await createStarted.promise;
    const disposal = thread.dispose();
    allowCreate.resolve();

    await expect(sending).rejects.toThrow("Thread killed");
    await disposal;
    expect(precreatedRunId).toEqual(expect.any(String));
    await expect(
      inspectDurableTurn(host, precreatedRunId ?? "")
    ).resolves.toMatchObject({
      runId: precreatedRunId,
      status: "cancelled",
    });
  });
});
