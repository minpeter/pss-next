import { describe, expect, it } from "vitest";
import { createCheckpointSpyHost } from "./execution-checkpoint-test-support";

describe("execution checkpoint test support", () => {
  it("preserves aggregate deletion with its base-store binding", async () => {
    const { host } = createCheckpointSpyHost();
    const threadKey = "checkpoint-wrapper-delete";
    await host.store.threads.commit(
      threadKey,
      { state: { messages: ["delete me"] } },
      { expectedVersion: null }
    );
    await host.store.inputs.admit({
      input: { text: "delete", type: "user-input" },
      kind: "send",
      messageId: "delete-input",
      threadKey,
    });
    const deleteThread = host.store.deleteThread;
    if (deleteThread === undefined) {
      throw new TypeError("checkpoint host must preserve aggregate deletion");
    }

    await deleteThread(threadKey);

    await expect(host.store.threads.load(threadKey)).resolves.toBeNull();
    await expect(
      host.store.inputs.claimNext(threadKey, "turn-idle")
    ).resolves.toBeNull();
  });
});
