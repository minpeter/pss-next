import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../thread/protocol/events";
import type { AgentTurn } from "../../thread/protocol/turn";
import { createCelldSqliteTestStorage } from "./celld-sqlite-test-storage";
import {
  type CelldScheduledWorkAgent,
  drainCelldScheduledWork,
} from "./drainer";
import { createCelldScheduler, listCelldScheduledRuns } from "./scheduler";

const AGENT_FAILURE = new Error("injected agentForRun failure");
const RESUME_FAILURE = new Error("injected resume failure");
const EVENT_FAILURE = new Error("injected onEvent failure");
const ACK_FAILURE = new Error("injected ack failure");
const RETRY_FAILURE = new Error("injected retry failure");
const REARM_FAILURE = new Error("injected final rearm failure");
const ACK_PATTERN = /^\s*DELETE FROM pss_scheduled_work\b/iu;
const RETRY_PATTERN = /UPDATE pss_scheduled_work SET claim_token = NULL/iu;

function agent(
  resume: () => Promise<AgentTurn | null>
): CelldScheduledWorkAgent {
  return {
    host: { store: { turns: { get: () => Promise.resolve(null) } } },
    resume,
  };
}

function turn(events: readonly AgentEvent[]): AgentTurn {
  return {
    async *events() {
      yield* events;
    },
    runId: "run-1",
  };
}

async function queuedStorage() {
  const storage = createCelldSqliteTestStorage();
  await createCelldScheduler({ clock: () => 0, storage }).enqueueRun("run-1");
  return storage;
}

async function expectRetriedAtOneSecond(
  storage: Awaited<ReturnType<typeof queuedStorage>>
): Promise<void> {
  await expect(
    listCelldScheduledRuns(storage, { nowMs: 999 })
  ).resolves.toEqual([]);
  await expect(
    listCelldScheduledRuns(storage, { nowMs: 1000 })
  ).resolves.toEqual(["run-1"]);
}

describe("Celld drainer failure recovery", () => {
  it("retries work when agentForRun rejects and preserves that error", async () => {
    // Given
    const storage = await queuedStorage();

    // When
    const drain = drainCelldScheduledWork({
      agentForRun: () => Promise.reject(AGENT_FAILURE),
      nowMs: 0,
      storage,
    });

    // Then
    await expect(drain).rejects.toBe(AGENT_FAILURE);
    await expectRetriedAtOneSecond(storage);
  });

  it("retries work when resume rejects and preserves that error", async () => {
    // Given
    const storage = await queuedStorage();

    // When
    const drain = drainCelldScheduledWork({
      agentForRun: () => agent(() => Promise.reject(RESUME_FAILURE)),
      nowMs: 0,
      storage,
    });

    // Then
    await expect(drain).rejects.toBe(RESUME_FAILURE);
    await expectRetriedAtOneSecond(storage);
  });

  it("awaits a rejecting onEvent callback before retrying work", async () => {
    // Given
    const storage = await queuedStorage();
    let callbackSettled = false;

    // When
    const drain = drainCelldScheduledWork({
      agentForRun: () =>
        agent(() => Promise.resolve(turn([{ type: "turn-start" }]))),
      nowMs: 0,
      onEvent: async () => {
        await Promise.resolve();
        callbackSettled = true;
        throw EVENT_FAILURE;
      },
      storage,
    });

    // Then
    await expect(drain).rejects.toBe(EVENT_FAILURE);
    expect(callbackSettled).toBe(true);
    await expectRetriedAtOneSecond(storage);
  });

  it("retries an acknowledgement SQL failure", async () => {
    // Given
    let failAck = true;
    const storage = createCelldSqliteTestStorage({
      sqlFailure: (query) => {
        if (failAck && ACK_PATTERN.test(query)) {
          failAck = false;
          return ACK_FAILURE;
        }
        return;
      },
    });
    await createCelldScheduler({ clock: () => 0, storage }).enqueueRun("run-1");

    // When
    const drain = drainCelldScheduledWork({
      agentForRun: () => agent(() => Promise.resolve(turn([]))),
      nowMs: 0,
      storage,
    });

    // Then
    await expect(drain).rejects.toBe(ACK_FAILURE);
    await expectRetriedAtOneSecond(storage);
  });

  it("preserves the processing error when retry SQL also fails", async () => {
    // Given
    const storage = createCelldSqliteTestStorage({
      sqlFailure: (query) =>
        RETRY_PATTERN.test(query) ? RETRY_FAILURE : undefined,
    });
    await createCelldScheduler({ clock: () => 0, storage }).enqueueRun("run-1");

    // When
    const drain = drainCelldScheduledWork({
      agentForRun: () => Promise.reject(AGENT_FAILURE),
      nowMs: 0,
      storage,
    });

    // Then
    await expect(drain).rejects.toBe(AGENT_FAILURE);
  });

  it("preserves the primary error when final rearm also fails", async () => {
    // Given
    const storage = createCelldSqliteTestStorage({
      setAlarm: () => Promise.reject(REARM_FAILURE),
    });
    storage.sql.exec(
      "CREATE TABLE pss_scheduled_work (prefix TEXT NOT NULL, kind TEXT NOT NULL, work_id TEXT NOT NULL, payload TEXT NOT NULL, thread_key TEXT, run_id TEXT, due_at INTEGER, created_at INTEGER NOT NULL)"
    );
    storage.sql.exec(
      "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      "pss-runtime",
      "celld-run",
      "broken",
      "{",
      0,
      0
    );

    // When
    const drain = drainCelldScheduledWork({
      agentForRun: () => agent(() => Promise.resolve(null)),
      nowMs: 0,
      storage,
    });

    // Then
    await expect(drain).rejects.toThrow(
      "Invalid Celld scheduled work payload."
    );
  });
});
