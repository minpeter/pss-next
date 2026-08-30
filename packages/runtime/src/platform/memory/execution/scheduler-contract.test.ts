import { describe, expect, it } from "vitest";
import { describeExecutionSchedulerContract } from "../../../contracts/execution-scheduler/contract";
import { InMemoryExecutionScheduler } from "./scheduler";

describeExecutionSchedulerContract({
  createHarness: () => {
    const scheduler = new InMemoryExecutionScheduler();
    return {
      ackRun: (runId) => scheduler.ackScheduledRun(runId),
      ackThreadPrompt: (prompt) => scheduler.ackScheduledThreadPrompt(prompt),
      listRuns: (options) => scheduler.listScheduledRuns(options),
      listThreadPrompts: (options) =>
        scheduler.listScheduledThreadPrompts(options),
      scheduler,
    };
  },
  name: "in-memory",
  supportsDueTimeFiltering: true,
});

describe("in-memory scheduler ownership boundaries", () => {
  it("does not expose mutable thread prompt storage", async () => {
    const scheduler = new InMemoryExecutionScheduler();
    await scheduler.resumeThread("thread-1", {
      idempotencyKey: "idem-1",
      runId: "run-1",
    });
    const [listed] = await scheduler.listScheduledThreadPrompts();
    Object.assign(listed, {
      runId: "escaped-run",
      threadKey: "escaped-thread",
    });

    await expect(scheduler.listScheduledThreadPrompts()).resolves.toEqual([
      {
        idempotencyKey: "idem-1",
        notificationId: undefined,
        runId: "run-1",
        threadKey: "thread-1",
      },
    ]);
  });
});
