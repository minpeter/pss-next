import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { AgentThread } from "../handle/agent-thread";
import { collect } from "../handle/test-support";

describe("public AgentTurn capability boundary", () => {
  it("does not expose durable cancellation authority or its binder", async () => {
    // Given: a real durable turn returned from the public thread surface.
    const host = createInMemoryHost();
    const thread = new AgentThread(
      {
        model: createCallbackModel(() => [
          assistantMessage("authority remains private"),
        ]),
      },
      { key: "turn-capability-boundary", store: host.store.threads },
      { executionHost: host }
    );

    // When: a caller inspects the runtime object behind AgentTurn.
    const turn = await thread.send("inspect public turn");
    const exposedOwnership = Reflect.get(turn, "executionOwnership");
    const exposedBinder = Reflect.get(turn, "bindRunId");
    await collect(turn);

    // Then: only the public runId value remains observable.
    expect(turn.runId).toBeTypeOf("string");
    expect(exposedOwnership).toBeUndefined();
    expect(exposedBinder).toBeUndefined();
  });
});
