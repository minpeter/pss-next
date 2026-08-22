import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeDiagnostic } from "../../diagnostics";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import {
  compactThreadBlocking,
  compactThreadManually,
  scheduleThreadCompaction,
} from "./auto-compaction-runner";
import {
  type AgentCompaction,
  DEFAULT_COMPACTION_DEADLINE_MS,
} from "./auto-compaction-types";

const MAX_DEADLINE_MS = 2_147_483_647;
const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};

async function stateWithHistory(): Promise<ThreadState> {
  const state = new ThreadState({
    key: "runner-deadline-test",
    store: new MemoryThreadStore(),
  });
  await state.ensureLoaded();
  const history: readonly ModelMessage[] = [
    { content: "old", role: "user" },
    assistantMessage("done"),
    { content: "tail", role: "user" },
  ];
  for (const message of history) {
    state.history.appendModelMessage(message);
  }
  return state;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("compaction deadlines", () => {
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

  it("keeps invalid manual deadline configuration throwing", async () => {
    const state = await stateWithHistory();

    await expect(
      compactThreadManually({
        deadlineMs: () => 0,
        model,
        state,
        threadKey: "manual-invalid",
      })
    ).rejects.toThrow(
      "Agent compaction deadlineMs() must return a positive safe integer"
    );
  });
});
