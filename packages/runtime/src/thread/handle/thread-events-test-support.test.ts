import { describe, expect, it } from "vitest";
import type { AgentHost } from "../../execution";
import { createInMemoryHost } from "../../platform/memory";
import {
  hostWithOneUsageAppendFailure,
  hostWithTurnErrorAppendFailure,
} from "./thread-events-test-support";

async function expectAggregateDeletion(host: AgentHost): Promise<void> {
  const threadKey = "wrapped-delete";
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
    throw new TypeError("wrapped host must preserve aggregate deletion");
  }

  await deleteThread(threadKey);

  await expect(host.store.threads.load(threadKey)).resolves.toBeNull();
  await expect(
    host.store.inputs.claimNext(threadKey, "turn-idle")
  ).resolves.toBeNull();
}

describe("thread event test host wrappers", () => {
  it.each([
    {
      name: "usage append failure",
      wrap: (base: AgentHost) =>
        hostWithOneUsageAppendFailure(base, () => undefined),
    },
    { name: "turn-error append failure", wrap: hostWithTurnErrorAppendFailure },
  ])("preserves aggregate deletion through $name", async ({ wrap }) => {
    await expectAggregateDeletion(wrap(createInMemoryHost()));
  });
});
