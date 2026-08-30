import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../../thread/handle/test-support";
import { dispatchAgentNotification } from "../dispatch/notification-dispatch";
import { inspectDurableTurn } from "./durable-turn";

describe("durable turn notification resume inspection", () => {
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
