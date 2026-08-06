import { describe, expect, it } from "vitest";
import { describeExecutionSchedulerContract } from "../../contracts/execution-scheduler/contract";
import { describeExecutionStoreContract } from "../../contracts/execution-store/contract";
import type { ScheduledThreadPrompt } from "../../execution/scheduled-work";
import { threadPromptScheduledWorkId } from "../../execution/scheduled-work";
import { InMemoryExecutionStore } from "../memory/execution/store";
import { createSqlQueueHost } from "./host";
import type { SqlQueuePort, SqlQueueWork } from "./scheduler";
import { SqlHostStore } from "./store";

describeExecutionStoreContract({
  createStore: () => new SqlHostStore(new InMemoryExecutionStore()),
  name: "SQL port reference",
});

class ReferenceQueue implements SqlQueuePort {
  readonly work = new Map<string, SqlQueueWork>();

  enqueue(item: SqlQueueWork): Promise<void> {
    if (!this.work.has(item.workId)) {
      this.work.set(item.workId, structuredClone(item));
    }
    return Promise.resolve();
  }
}

describeExecutionSchedulerContract({
  createHarness: () => {
    const queue = new ReferenceQueue();
    const scheduler = createSqlQueueHost({
      queue,
      store: new InMemoryExecutionStore(),
    }).scheduler;
    return {
      ackRun: (runId: string) => {
        queue.work.delete(`run:${runId}`);
        return Promise.resolve();
      },
      ackThreadPrompt: (prompt: ScheduledThreadPrompt) => {
        queue.work.delete(
          `thread-prompt:${threadPromptScheduledWorkId(prompt)}`
        );
        return Promise.resolve();
      },
      listRuns: (options: { limit?: number; nowMs?: number } = {}) =>
        Promise.resolve(
          [...queue.work.values()]
            .filter(
              (item) =>
                item.kind === "run" &&
                item.dueAtMs <= (options.nowMs ?? Date.now())
            )
            .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
            .map((item) => (item.kind === "run" ? item.runId : ""))
        ),
      listThreadPrompts: (options: { limit?: number; nowMs?: number } = {}) =>
        Promise.resolve(
          [...queue.work.values()]
            .filter(
              (item) =>
                item.kind === "thread-prompt" &&
                item.dueAtMs <= (options.nowMs ?? Date.now())
            )
            .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
            .flatMap((item) =>
              item.kind === "thread-prompt" ? [item.prompt] : []
            )
        ),
      scheduler,
    };
  },
  name: "SQL queue reference",
  supportsDueTimeFiltering: true,
});

describe("SQL queue wake behavior", () => {
  it("persists work before signaling wake", async () => {
    const calls: string[] = [];
    const queue: SqlQueuePort = {
      enqueue: () => {
        calls.push("enqueue");
        return Promise.resolve();
      },
    };
    const host = createSqlQueueHost({
      clock: () => 1000,
      queue,
      store: new InMemoryExecutionStore(),
      wake: (dueAtMs) => {
        calls.push(`wake:${dueAtMs}`);
      },
    });

    await host.scheduler.enqueueRun("run-1", { runAfterMs: 250 });

    expect(calls).toEqual(["enqueue", "wake:1250"]);
  });

  it("leaves durably enqueued work available when wake fails", async () => {
    const queue = new ReferenceQueue();
    const host = createSqlQueueHost({
      queue,
      store: new InMemoryExecutionStore(),
      wake: () => {
        throw new Error("broker unavailable");
      },
    });

    await expect(host.scheduler.enqueueRun("run-1")).rejects.toThrow(
      "broker unavailable"
    );
    expect(queue.work.get("run:run-1")).toMatchObject({
      kind: "run",
      runId: "run-1",
    });
  });
});
