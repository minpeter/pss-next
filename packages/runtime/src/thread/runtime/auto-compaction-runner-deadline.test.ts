import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeDiagnostic } from "../../diagnostics";
import { createDeferred } from "../../testing/test-fixtures";
import {
  compactThreadBlocking,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import {
  MAX_DEADLINE_MS,
  model,
  stateWithHistory,
} from "./auto-compaction-runner-deadline-support";
import {
  type AgentCompaction,
  DEFAULT_COMPACTION_DEADLINE_MS,
} from "./auto-compaction-types";

afterEach(() => {
  vi.useRealTimers();
});

describe("compaction deadlines", () => {
  it("resolves a completed-turn deadline when scheduling is admitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const state = await stateWithHistory();
    const diagnosticReported = createDeferred();
    let observedDeadlineAt: number | undefined;
    const compaction = Object.assign(vi.fn<AgentCompaction>(), {
      deadlineMs: () => 25,
    }) satisfies AgentCompaction;

    const scheduled = scheduleThreadCompaction({
      compaction,
      model: {
        ...model,
        diagnostics: {
          report(diagnostic: RuntimeDiagnostic): void {
            observedDeadlineAt = diagnostic.compaction?.deadlineAt;
            diagnosticReported.resolve();
          },
        },
      },
      state,
      threadKey: "admission-deadline",
    });
    vi.setSystemTime(new Date(10_100));
    await Promise.all([scheduled, diagnosticReported.promise]);

    expect(observedDeadlineAt).toBe(10_025);
    expect(compaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      deadlineMs: () => 0,
      name: "non-positive",
    },
    {
      deadlineMs: () => 1.5,
      name: "non-integer",
    },
    {
      deadlineMs: () => MAX_DEADLINE_MS + 1,
      name: "timer overflow",
    },
    {
      deadlineMs: () => {
        throw new Error("private deadline failure");
      },
      name: "throwing",
    },
  ])(
    "falls back and warns once for a $name automatic deadline",
    async ({ deadlineMs }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(5000));
      const diagnostics: RuntimeDiagnostic[] = [];
      const state = await stateWithHistory();
      let observedDeadlineAt: number | undefined;
      const compaction = Object.assign(
        (context: Parameters<AgentCompaction>[0]): undefined => {
          observedDeadlineAt = context.deadlineAt;
          return;
        },
        { deadlineMs }
      ) satisfies AgentCompaction;

      await scheduleThreadCompaction({
        compaction,
        model: {
          ...model,
          diagnostics: {
            report(diagnostic: RuntimeDiagnostic): void {
              diagnostics.push(diagnostic);
            },
          },
        },
        state,
        threadKey: "private-thread-key",
      });

      expect(observedDeadlineAt).toBe(5000 + DEFAULT_COMPACTION_DEADLINE_MS);
      expect(diagnostics).toEqual([
        {
          code: "compaction.deadline-invalid",
          level: "warning",
          phase: "auto-compaction",
        },
        expect.objectContaining({
          code: "compaction.skipped",
          level: "info",
        }),
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain("private");
    }
  );

  it("accepts the maximum timer-safe automatic deadline without clamping", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(20_000));
    const state = await stateWithHistory();
    let observedDeadlineAt: number | undefined;
    const compaction = Object.assign(
      (context: Parameters<AgentCompaction>[0]): undefined => {
        observedDeadlineAt = context.deadlineAt;
        return;
      },
      { deadlineMs: () => MAX_DEADLINE_MS }
    ) satisfies AgentCompaction;

    await compactThreadBlocking({
      compaction,
      model,
      state,
      threadKey: "max-deadline",
    });

    expect(observedDeadlineAt).toBe(20_000 + MAX_DEADLINE_MS);
  });
});
