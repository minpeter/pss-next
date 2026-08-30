import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import { ThreadState } from "../state/thread-state";
import {
  cancelThreadExecutionRun,
  precreateThreadExecutionRun,
  startThreadExecutionRun,
} from "./execution";

describe("thread execution run lifecycle helpers", () => {
  it("precreates, starts, and cancels one durable run", async () => {
    const host = createInMemoryHost();
    const threadKey = "helper-lifecycle";
    const runId = "turn:v1:helper-lifecycle:message-1";
    const state = new ThreadState({
      key: threadKey,
      store: host.store.threads,
    });

    const precreated = await precreateThreadExecutionRun({
      executionHost: host,
      kind: "user-turn",
      runId,
      threadKey,
    });
    expect(precreated).toMatchObject({ runId, status: "queued", threadKey });

    const started = await startThreadExecutionRun({
      executionHost: host,
      executionRun: { kind: "user-turn", runId },
      state,
      threadKey,
      turnId: "unused",
    });
    expect(started?.runId).toBe(runId);
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "running",
    });

    await cancelThreadExecutionRun({
      cancellation: { kind: "owned", leaseId: null, runId },
      executionHost: host,
    });
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("preserves every terminal status during cancellation", async () => {
    const statuses = [
      "cancelled",
      "completed",
      "error",
      "needs-recovery",
    ] as const;

    for (const status of statuses) {
      const host = createInMemoryHost();
      const runId = `terminal-${status}`;
      await host.store.turns.create({
        checkpointVersion: 0,
        kind: "user-turn",
        rootRunId: runId,
        runId,
        status,
        threadKey: "terminal-thread",
      });

      await cancelThreadExecutionRun({
        cancellation: { kind: "unleased", runId },
        executionHost: host,
      });
      await expect(host.store.turns.get(runId)).resolves.toMatchObject({
        status,
      });
    }
  });
});
