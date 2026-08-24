import { describe, expect, it, vi } from "vitest";
import type { RuntimeDiagnostic } from "../../diagnostics";
import {
  compactThreadBlocking,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import {
  model,
  stateWithHistory,
} from "./auto-compaction-runner-concurrency-support";
import {
  type AgentCompaction,
  DEFAULT_COMPACTION_DEADLINE_MS,
} from "./auto-compaction-types";

describe("compaction runner concurrency", () => {
  it("reports bounded lifecycle accounting without thread contents", async () => {
    const diagnostics: RuntimeDiagnostic[] = [];
    const state = await stateWithHistory();
    const localModel = {
      ...model,
      diagnostics: {
        report(diagnostic: RuntimeDiagnostic): void {
          diagnostics.push(diagnostic);
        },
      },
    };

    await compactThreadBlocking({
      compaction: async () => ({
        endSeqExclusive: 2,
        startSeq: 0,
        summary: "secret summary",
      }),
      model: localModel,
      state,
      threadKey: "secret-thread",
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "compaction.completed",
        level: "info",
        compaction: expect.objectContaining({
          outcome: "committed",
          reason: "overflow",
          runnerAttempt: 1,
          summaryCalls: 0,
        }),
        phase: "auto-compaction",
      }),
    ]);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("secret summary");
    expect(serialized).not.toContain("secret-thread");
    expect(serialized).not.toContain("old");
    expect(serialized).not.toContain("tail");
  });

  it("applies the shared episode bound when a policy omits deadlineMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(12_345));
    const state = await stateWithHistory();
    let deadlineAt: number | undefined;

    try {
      await compactThreadBlocking({
        compaction: (context): undefined => {
          deadlineAt = context.deadlineAt;
          return;
        },
        model,
        state,
        threadKey: "thread",
      });

      expect(deadlineAt).toBe(12_345 + DEFAULT_COMPACTION_DEADLINE_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back when scheduleThreadCompaction deadlineMs throws", async () => {
    const state = await stateWithHistory();
    const before = state.modelSnapshot();
    const compaction = Object.assign(
      async () => ({
        endSeqExclusive: 2,
        startSeq: 0,
        summary: "summary",
      }),
      {
        deadlineMs: () => {
          throw new Error("boom");
        },
      }
    ) satisfies AgentCompaction;

    await expect(
      scheduleThreadCompaction({
        compaction,
        model,
        state,
        threadKey: "thread",
      })
    ).resolves.toBeUndefined();
    expect(state.modelSnapshot()).toEqual(before);
    expect(state.compactionSnapshot()).toMatchObject([
      { summary: { content: "summary", role: "system" } },
    ]);
  });

  it("does not throw from scheduleThreadCompaction when deadlineMs is invalid", async () => {
    const state = await stateWithHistory();
    const before = state.modelSnapshot();
    const compaction = Object.assign(
      (): undefined => {
        return;
      },
      { deadlineMs: () => 0 }
    ) satisfies AgentCompaction;

    await expect(
      scheduleThreadCompaction({
        compaction,
        model,
        state,
        threadKey: "thread",
      })
    ).resolves.toBeUndefined();
    expect(state.modelSnapshot()).toEqual(before);
  });
});
