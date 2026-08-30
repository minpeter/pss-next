import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import { userText } from "../../testing/test-fixtures";
import type { QueuedInput } from "../input/runtime-input";
import { ThreadState } from "../state/thread-state";
import { startThreadExecutionRun } from "./execution";
import { queueThreadNotification } from "./notification";

describe("notification execution ownership", () => {
  it("preserves the claimed lease while queueing and fences replacement owners", async () => {
    // Given: owner A queues a resumed notification before owner B takes over.
    const host = createInMemoryHost();
    const inputQueue: QueuedInput[] = [];
    const runId = "queued-notification-owner";
    await host.store.turns.create({
      checkpointVersion: 0,
      kind: "notification",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey: "thread",
    });
    const ownerA = await host.store.turns.claim(runId, {
      attempt: 1,
      leaseId: "owner-a",
      leaseMs: 100,
      nowMs: 10,
    });
    if (!ownerA.ok) {
      throw new TypeError("Expected owner A to claim the notification.");
    }

    // When: the notification is queued with owner A's captured capability.
    await queueThreadNotification(
      userText("resume"),
      {
        executionRun: {
          kind: "notification",
          leaseId: "owner-a",
          runId,
        },
      },
      {
        activeRun: undefined,
        activeRuntimeInput: undefined,
        attachmentStore: undefined,
        drain: () => Promise.resolve(),
        emitObserverEvent: () => Promise.resolve(),
        executionHost: host,
        inputQueue,
        pendingRuntimeInputs: [],
        threadKey: "thread",
        throwIfTerminal: () => undefined,
      }
    );
    const queued = inputQueue[0]?.executionRun;

    // Then: queueing preserves owner A and owner B's takeover fences startup.
    expect(queued).toEqual({
      kind: "notification",
      leaseId: "owner-a",
      runId,
    });
    const ownerB = await host.store.turns.claim(runId, {
      attempt: 2,
      leaseId: "owner-b",
      leaseMs: 100,
      nowMs: 200,
    });
    if (!ownerB.ok) {
      throw new TypeError("Expected owner B to replace owner A.");
    }
    await expect(
      startThreadExecutionRun({
        executionHost: host,
        executionRun: queued,
        state: new ThreadState({ key: "thread", store: host.store.threads }),
        threadKey: "thread",
        turnId: "unused",
      })
    ).rejects.toMatchObject({
      name: "TurnTransitionConflictError",
      reason: "lease-conflict",
      runId,
    });
    await expect(host.store.turns.get(runId)).resolves.toEqual(ownerB.record);
  });
});
