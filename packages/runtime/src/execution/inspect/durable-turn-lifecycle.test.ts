import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
} from "../../testing/test-fixtures";
import { collect } from "../../thread/handle/test-support";
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
});
