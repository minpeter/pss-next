import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { AgentThread } from "../../thread/handle/agent-thread";
import { collect } from "../../thread/handle/test-support";
import { inspectDurableTurn } from "./durable-turn";

describe("durable turn cancellation inspection", () => {
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
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      inspectDurableTurn(host, active.runId ?? "")
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      inspectDurableTurn(host, queued.runId ?? "")
    ).resolves.toMatchObject({ status: "cancelled" });
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
});
