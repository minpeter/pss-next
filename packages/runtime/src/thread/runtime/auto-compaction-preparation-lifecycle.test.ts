import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Deferred, deferred } from "../../internal/deferred";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import { compactThreadBlocking } from "./auto-compaction-runner";
import type {
  AgentCompaction,
  AgentCompactionContext,
} from "./auto-compaction-types";

const range = { endSeqExclusive: 2, startSeq: 0 };
const candidate = { ...range, summary: "candidate" };

interface RetainedCapability {
  readonly signal: AbortSignal;
  readonly summarize: AgentCompactionContext["summarize"];
}

async function stateWithHistory(key: string): Promise<ThreadState> {
  const state = new ThreadState({ key, store: new MemoryThreadStore() });
  await state.ensureLoaded();
  const history: readonly ModelMessage[] = [
    { content: "old context ".repeat(200), role: "user" },
    assistantMessage("done"),
    { content: "tail", role: "user" },
  ];
  for (const message of history) {
    state.history.appendModelMessage(message);
  }
  return state;
}

function captureCapability(
  captured: Deferred<RetainedCapability>,
  context: AgentCompactionContext
): void {
  captured.resolve({ signal: context.signal, summarize: context.summarize });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("summary episode capability", () => {
  it.each([
    { expected: false, name: "policy skip", result: undefined },
    { expected: true, name: "commit", result: candidate },
  ])(
    "closes retained summarize after $name",
    async ({ expected, name, result }) => {
      // Given
      const state = await stateWithHistory(`summary-capability-${name}`);
      const captured = deferred<RetainedCapability>();
      const provider = vi.fn(() => [assistantMessage("summary")]);
      const compaction: AgentCompaction = (context) => {
        captureCapability(captured, context);
        return result;
      };

      // When
      await expect(
        compactThreadBlocking({
          compaction,
          model: { model: createCallbackModel(provider) },
          state,
          threadKey: `summary-capability-${name}`,
        })
      ).resolves.toBe(expected);
      const capability = await captured.promise;

      // Then
      expect(capability.signal.aborted).toBe(true);
      await expect(capability.summarize(range)).rejects.toBe(
        capability.signal.reason
      );
      expect(provider).not.toHaveBeenCalled();
    }
  );

  it("returns a rejected promise for an invalid summary range", async () => {
    // Given
    const state = await stateWithHistory("summary-invalid-range");
    let summary: Promise<string> | undefined;
    const compaction: AgentCompaction = (context): undefined => {
      expect(() => {
        summary = context.summarize({ endSeqExclusive: 4, startSeq: 0 });
      }).not.toThrow();
      return;
    };

    // When
    await expect(
      compactThreadBlocking({
        compaction,
        model: {
          model: createCallbackModel(() => [assistantMessage("unused")]),
        },
        state,
        threadKey: "summary-invalid-range",
      })
    ).resolves.toBe(false);

    // Then
    expect(summary).toBeDefined();
    await expect(summary).rejects.toThrow(
      "Compaction callback returned an invalid source range."
    );
  });

  it("closes retained summarize after a custom handler returns", async () => {
    // Given
    const state = await stateWithHistory("summary-capability-handler");
    const captured = deferred<RetainedCapability>();
    const provider = vi.fn(() => [assistantMessage("summary")]);
    const compaction: AgentCompaction = (context) => {
      captureCapability(captured, context);
      return candidate;
    };

    // When
    await expect(
      compactThreadBlocking({
        compact: async () => false,
        compaction,
        model: { model: createCallbackModel(provider) },
        state,
        threadKey: "summary-capability-handler",
      })
    ).resolves.toBe(false);
    const capability = await captured.promise;

    // Then
    expect(capability.signal.aborted).toBe(true);
    await expect(capability.summarize(range)).rejects.toBe(
      capability.signal.reason
    );
    expect(provider).not.toHaveBeenCalled();
  });

  it("closes retained summarize after timeout", async () => {
    // Given
    vi.useFakeTimers();
    const state = await stateWithHistory("summary-capability-timeout");
    const captured = deferred<RetainedCapability>();
    const provider = vi.fn(() => [assistantMessage("summary")]);
    const compaction = Object.assign(
      async (context: AgentCompactionContext) => {
        captureCapability(captured, context);
        return await new Promise<undefined>(() => undefined);
      },
      { deadlineMs: () => 10 }
    ) satisfies AgentCompaction;
    const running = compactThreadBlocking({
      compaction,
      model: { model: createCallbackModel(provider) },
      state,
      threadKey: "summary-capability-timeout",
    });
    const capability = await captured.promise;
    const runningOutcome = expect(running).rejects.toMatchObject({
      name: "CompactionDeadlineExceededError",
      reason: "overflow",
    });

    // When
    await vi.advanceTimersByTimeAsync(10);

    // Then
    await runningOutcome;
    expect(capability.signal.aborted).toBe(true);
    await expect(capability.summarize(range)).rejects.toBe(
      capability.signal.reason
    );
    expect(provider).not.toHaveBeenCalled();
  });

  it("closes retained summarize after caller abort", async () => {
    // Given
    const state = await stateWithHistory("summary-capability-caller-abort");
    const captured = deferred<RetainedCapability>();
    const provider = vi.fn(() => [assistantMessage("summary")]);
    const controller = new AbortController();
    const abortReason = new TypeError("caller cancelled");
    const compaction: AgentCompaction = async (context) => {
      captureCapability(captured, context);
      return await new Promise<undefined>(() => undefined);
    };
    const running = compactThreadBlocking({
      compaction,
      model: { model: createCallbackModel(provider) },
      signal: controller.signal,
      state,
      threadKey: "summary-capability-caller-abort",
    });
    const capability = await captured.promise;

    // When
    controller.abort(abortReason);

    // Then
    await expect(running).rejects.toBe(abortReason);
    expect(capability.signal.aborted).toBe(true);
    await expect(capability.summarize(range)).rejects.toBe(abortReason);
    expect(provider).not.toHaveBeenCalled();
  });

  it("handles a provider rejection caused by episode settlement", async () => {
    // Given
    const state = await stateWithHistory("summary-capability-late-rejection");
    const providerStarted = createDeferred();
    const capturedSignal = deferred<AbortSignal>();
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    const observeUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", observeUnhandled);
    const compaction: AgentCompaction = async (context): Promise<undefined> => {
      capturedSignal.resolve(context.signal);
      context.summarize(range);
      await providerStarted.promise;
      return;
    };
    const running = compactThreadBlocking({
      compaction,
      model: {
        model: createCallbackModel(
          ({ signal }) =>
            new Promise((_resolve, reject) => {
              providerStarted.resolve();
              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            })
        ),
      },
      signal: controller.signal,
      state,
      threadKey: "summary-capability-late-rejection",
    });

    try {
      // When
      await expect(running).resolves.toBe(false);
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Then
      expect((await capturedSignal.promise).aborted).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
      controller.abort(new TypeError("test cleanup"));
      await Promise.allSettled([running]);
    }
  });
});
