import { describe, expect, it } from "vitest";
import type { TurnRecord, TurnStatus } from "../../execution/host/types";
import type { AgentEvent } from "../../thread/protocol/events";
import type { AgentTurn } from "../../thread/protocol/turn";
import { InMemoryCloudflareDurableObjectStorage } from "../cloudflare";
import {
  type CelldScheduledWorkAgent,
  drainCelldScheduledWork,
} from "./drainer";
import { createCelldScheduler, listCelldScheduledRuns } from "./scheduler";

describe("drainCelldScheduledWork", () => {
  it("consumes run events and acknowledges completed work", async () => {
    const storage = createStorage();
    const scheduler = createCelldScheduler({ clock: () => 0, storage });
    await scheduler.enqueueRun("run-1");
    const events: AgentEvent[] = [{ type: "turn-start" }, { type: "turn-end" }];
    const agent = createAgent({ run: turn(events) });

    const result = await drainCelldScheduledWork({
      agentForRun: () => agent,
      nowMs: 0,
      storage,
    });

    expect(result.events).toEqual(events);
    expect(result.ackedRuns).toEqual(["run-1"]);
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 0 })
    ).resolves.toEqual([]);
  });

  it("leaves a nonterminal null resume pending", async () => {
    const storage = createStorage();
    const scheduler = createCelldScheduler({ clock: () => 0, storage });
    await scheduler.enqueueRun("run-1");
    const agent = createAgent({ record: runRecord("queued"), run: null });

    const result = await drainCelldScheduledWork({
      agentForRun: () => agent,
      nowMs: 0,
      storage,
    });

    expect(result.skippedRuns).toEqual(["run-1"]);
    await expect(
      listCelldScheduledRuns(storage, { nowMs: 0 })
    ).resolves.toEqual(["run-1"]);
  });

  it("acknowledges terminal and missing null resumes", async () => {
    for (const record of [runRecord("completed"), null]) {
      const storage = createStorage();
      const scheduler = createCelldScheduler({ clock: () => 0, storage });
      await scheduler.enqueueRun("run-1");

      const result = await drainCelldScheduledWork({
        agentForRun: () => createAgent({ record, run: null }),
        nowMs: 0,
        storage,
      });

      expect(result.ackedRuns).toEqual(["run-1"]);
      await expect(
        listCelldScheduledRuns(storage, { nowMs: 0 })
      ).resolves.toEqual([]);
    }
  });
});

function createAgent({
  record = null,
  run,
}: {
  readonly record?: TurnRecord | null;
  readonly run: AgentTurn | null;
}): CelldScheduledWorkAgent {
  return {
    host: {
      store: {
        turns: {
          get: () => Promise.resolve(record),
        },
      },
    },
    resume: () => Promise.resolve(run),
  };
}

function turn(values: readonly AgentEvent[]): AgentTurn {
  async function* events() {
    yield* values;
  }
  return {
    events,
    runId: "run-1",
  };
}

function runRecord(status: TurnStatus): TurnRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: "run-1",
    runId: "run-1",
    status,
    threadKey: "thread-1",
  };
}

function createStorage() {
  const inner = new InMemoryCloudflareDurableObjectStorage();
  let alarm: number | null = null;
  return {
    delete: (key: string) => inner.delete(key),
    deleteAlarm: () => {
      alarm = null;
      return Promise.resolve();
    },
    get: <T>(key: string) => inner.get<T>(key),
    getAlarm: () => Promise.resolve(alarm),
    put: <T>(key: string, value: T) => inner.put(key, value),
    setAlarm: async (time: Date | number) => {
      alarm = typeof time === "number" ? time : time.getTime();
      await inner.setAlarm(time);
    },
    sql: inner.sql,
    transaction: inner.transaction.bind(inner),
    transactionSync: inner.transactionSync.bind(inner),
  };
}
