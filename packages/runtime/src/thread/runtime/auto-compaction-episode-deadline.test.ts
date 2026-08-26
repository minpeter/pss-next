import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import { compactThreadBlocking } from "./auto-compaction-runner";
import type { AgentCompaction } from "./auto-compaction-types";

const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};

async function stateWithHistory(): Promise<ThreadState> {
  const state = new ThreadState({
    key: "episode-deadline-test",
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

function deadlinePolicy(
  result:
    | {
        readonly endSeqExclusive: number;
        readonly startSeq: number;
        readonly summary: string;
      }
    | undefined
): AgentCompaction {
  return Object.assign(
    (): typeof result => {
      vi.setSystemTime(new Date(1006));
      return result;
    },
    { deadlineMs: () => 5 }
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("compaction episode absolute deadline", () => {
  it.each([
    {
      name: "policy returns no candidate",
      result: undefined,
    },
    {
      name: "policy returns an empty candidate",
      result: { endSeqExclusive: 2, startSeq: 0, summary: "   " },
    },
  ])(
    "rejects when synchronous $name after the deadline",
    async ({ result }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));
      const state = await stateWithHistory();

      await expect(
        compactThreadBlocking({
          compaction: deadlinePolicy(result),
          model,
          state,
          threadKey: "synchronous-preparation-deadline",
        })
      ).rejects.toMatchObject({
        deadlineAt: 1005,
        deadlineMs: 5,
        name: "CompactionDeadlineExceededError",
        reason: "overflow",
      });
      expect(state.compactionSnapshot()).toEqual([]);
    }
  );

  it("rejects when a synchronous custom handler skips after the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const state = await stateWithHistory();
    const compaction = Object.assign(
      () => ({ endSeqExclusive: 2, startSeq: 0, summary: "candidate" }),
      { deadlineMs: () => 5 }
    ) satisfies AgentCompaction;

    await expect(
      compactThreadBlocking({
        compact: () => {
          vi.setSystemTime(new Date(1006));
          return Promise.resolve(false);
        },
        compaction,
        model,
        state,
        threadKey: "synchronous-handler-deadline",
      })
    ).rejects.toMatchObject({
      deadlineAt: 1005,
      deadlineMs: 5,
      name: "CompactionDeadlineExceededError",
      reason: "overflow",
    });
    expect(state.compactionSnapshot()).toEqual([]);
  });

  it("preserves caller abort precedence over a deadline crossing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const state = await stateWithHistory();
    const controller = new AbortController();
    const abortReason = new TypeError("caller cancelled");
    const compaction = Object.assign(
      (): undefined => {
        vi.setSystemTime(new Date(1006));
        controller.abort(abortReason);
        return;
      },
      { deadlineMs: () => 5 }
    ) satisfies AgentCompaction;

    await expect(
      compactThreadBlocking({
        compaction,
        model,
        signal: controller.signal,
        state,
        threadKey: "caller-abort-precedence",
      })
    ).rejects.toBe(abortReason);
  });

  it("keeps an in-budget no-candidate outcome as a skip", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const state = await stateWithHistory();
    const compaction = Object.assign((): undefined => undefined, {
      deadlineMs: () => 5,
    }) satisfies AgentCompaction;

    await expect(
      compactThreadBlocking({
        compaction,
        model,
        state,
        threadKey: "in-budget-skip",
      })
    ).resolves.toBe(false);
  });
});
