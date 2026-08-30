import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
  userText,
} from "../../testing/test-fixtures";
import { AgentThread } from "../../thread/handle/agent-thread";
import { collect } from "../../thread/handle/test-support";
import { dispatchAgentNotification } from "../dispatch/notification-dispatch";
import { inspectDurableTurn } from "./durable-turn";

describe("durable turn lifecycle inspection", () => {
  it("exposes one run id across queued, running, and completed send states", async () => {
    const host = createInMemoryHost();
    const activeStarted = createDeferred();
    const activeGate = createDeferred();
    let calls = 0;
    const agent = new Agent({
      host,
      model: createCallbackModel(async () => {
        calls += 1;
        if (calls === 1) {
          activeStarted.resolve();
          await activeGate.promise;
        }
        return [assistantMessage(`done ${calls}`)];
      }),
    });
    const thread = agent.thread("lifecycle-send");
    const active = await thread.send("active");
    const activeDrain = collect(active);
    await activeStarted.promise;
    const queued = await thread.send("queued");

    expect(active.runId).toEqual(expect.any(String));
    expect(queued.runId).toEqual(expect.any(String));
    expect(queued.runId).not.toBe(active.runId);
    await expect(
      inspectDurableTurn(host, active.runId ?? "")
    ).resolves.toMatchObject({
      runId: active.runId,
      status: "running",
      threadKey: "lifecycle-send",
    });
    await expect(
      inspectDurableTurn(host, queued.runId ?? "")
    ).resolves.toMatchObject({
      runId: queued.runId,
      status: "queued",
      threadKey: "lifecycle-send",
    });

    activeGate.resolve();
    await activeDrain;
    await collect(queued);

    await expect(
      inspectDurableTurn(host, active.runId ?? "")
    ).resolves.toMatchObject({
      runId: active.runId,
      status: "completed",
    });
    await expect(
      inspectDurableTurn(host, queued.runId ?? "")
    ).resolves.toMatchObject({
      runId: queued.runId,
      status: "completed",
    });
  });

  it("reports failed durable turns without changing event semantics", async () => {
    const host = createInMemoryHost();
    const agent = new Agent({
      host,
      model: createCallbackModel(() => {
        throw new Error("model failed");
      }),
    });

    const turn = await agent.send("fail");
    expect(eventTypes(await collect(turn))).toContain("turn-error");
    await expect(
      inspectDurableTurn(host, turn.runId ?? "")
    ).resolves.toMatchObject({
      runId: turn.runId,
      state: "no-checkpoint",
      status: "error",
    });
  });

  it("cancels queued and active runs on dispose while preserving completed runs", async () => {
    const host = createInMemoryHost();
    const activeStarted = createDeferred();
    const activeGate = createDeferred();
    let calls = 0;
    const agent = new Agent({
      host,
      model: createCallbackModel(async () => {
        calls += 1;
        if (calls === 2) {
          activeStarted.resolve();
          await activeGate.promise;
        }
        return [assistantMessage(`done ${calls}`)];
      }),
    });
    const thread = agent.thread("lifecycle-cancel");
    const completed = await thread.send("complete first");
    await collect(completed);
    const active = await thread.send("active");
    const activeDrain = collect(active);
    await activeStarted.promise;
    const queued = await thread.send("queued");
    const queuedDrain = collect(queued);

    const disposal = thread.dispose();
    activeGate.resolve();
    await disposal;
    await Promise.all([activeDrain, queuedDrain]);

    await expect(
      inspectDurableTurn(host, completed.runId ?? "")
    ).resolves.toMatchObject({
      status: "completed",
    });
    await expect(
      inspectDurableTurn(host, active.runId ?? "")
    ).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(
      inspectDurableTurn(host, queued.runId ?? "")
    ).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(
      host.store.inputs.claimNext("lifecycle-cancel", "turn-idle")
    ).resolves.toBeNull();
  });

  it("awaits durable active-run cancellation from kill", async () => {
    const host = createInMemoryHost();
    const modelStarted = createDeferred();
    const modelGate = createDeferred();
    const thread = new AgentThread(
      {
        model: createCallbackModel(async () => {
          modelStarted.resolve();
          await modelGate.promise;
          return [assistantMessage("done")];
        }),
      },
      { key: "lifecycle-kill", store: host.store.threads },
      { executionHost: host }
    );
    const turn = await thread.send("kill active run");
    const drain = collect(turn);
    await modelStarted.promise;

    const killed = thread.kill();
    modelGate.resolve();
    await killed;
    await drain;

    await expect(
      inspectDurableTurn(host, turn.runId ?? "")
    ).resolves.toMatchObject({
      runId: turn.runId,
      status: "cancelled",
    });
  });

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
            transition: (runId, expected, record) =>
              transaction.turns.transition(runId, expected, record),
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

  it("resumes notification processing on the dispatched run id", async () => {
    const host = createInMemoryHost();
    const modelStarted = createDeferred();
    const modelGate = createDeferred();
    const agent = new Agent({
      host,
      model: createCallbackModel(async () => {
        modelStarted.resolve();
        await modelGate.promise;
        return [assistantMessage("resumed")];
      }),
      namespace: "resume-owner",
    });
    const dispatched = await dispatchAgentNotification({
      host,
      idempotencyKey: "lifecycle-resume",
      input: userText("resume notification"),
      namespace: "resume-owner",
      threadKey: "lifecycle-resume",
    });

    const turn = await agent.resume(dispatched.runId);
    expect(turn?.runId).toBe(dispatched.runId);
    if (!turn) {
      throw new Error("Expected dispatched notification to resume.");
    }
    const drain = collect(turn);
    await modelStarted.promise;
    await expect(
      inspectDurableTurn(host, dispatched.runId)
    ).resolves.toMatchObject({
      runId: dispatched.runId,
      status: "running",
      threadKey: "lifecycle-resume",
    });

    modelGate.resolve();
    await drain;
    await expect(
      inspectDurableTurn(host, dispatched.runId)
    ).resolves.toMatchObject({
      runId: dispatched.runId,
      status: "completed",
    });
  });
});
