import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "./test-support";

describe("AgentThread manual compaction durable claims", () => {
  it("recovers an existing durable claim before hosted manual compaction", async () => {
    // Given: persisted history and a durable input claim orphaned by its owner.
    const threadKey = "manual-compaction-claim-recovery";
    const host = createInMemoryHost();
    const setupAgent = new Agent({
      host,
      model: createCallbackModel(() => [assistantMessage("OLD")]),
    });
    await collect(
      await setupAgent.thread(threadKey).send("history ".repeat(100))
    );
    await setupAgent.dispose();
    await host.store.inputs.admit({
      admittedAtMs: 1,
      input: userText("orphaned"),
      kind: "send",
      messageId: "orphaned-message",
      threadKey,
    });
    const orphanedClaim = await host.store.inputs.claimNext(
      threadKey,
      "turn-idle"
    );
    if (!orphanedClaim) {
      throw new Error("expected durable input claim");
    }
    const recoverClaims = vi.spyOn(host.store.inputs, "recoverClaims");
    const recoveryCountsAtCompaction: number[] = [];
    const compactingThread = new Agent({
      host,
      model: createCallbackModel(() => {
        recoveryCountsAtCompaction.push(recoverClaims.mock.calls.length);
        return [assistantMessage("SUMMARY")];
      }),
    }).thread(threadKey);

    // When: another hosted handle manually compacts the thread.
    const result = await compactingThread.compact();

    // Then: claim recovery precedes provider compaction and invalidates the stale claim.
    expect(result).toEqual({ status: "compacted" });
    expect(recoveryCountsAtCompaction).toEqual([1]);
    await expect(
      host.store.inputs.releaseClaim(orphanedClaim)
    ).resolves.toBeNull();
  });
});
