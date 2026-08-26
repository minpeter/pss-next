import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { withSemanticScore } from "./compare-pi-judge";
import type { ArmResult } from "./compare-pi-types";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model";

const resultWithMisses = (missCount: number, exactCorrect = 0): ArmResult => {
  const total = missCount + exactCorrect;
  return {
    score: {
      arms: {
        compacted: {
          overall: { correct: exactCorrect, total },
          perCategory: [],
        },
        full: {
          overall: { correct: total, total },
          perCategory: [],
        },
      },
      disagreements: Array.from({ length: missCount }, (_, index) => ({
        actual: `candidate-${index}`,
        arm: "compacted",
        category: "exact-recall",
        expected: `reference-${index}`,
        question: `question-${index}`,
      })),
      headline: { correct: exactCorrect, total },
    },
    status: "valid",
  };
};

describe("withSemanticScore", () => {
  it("shares one provider deadline across every exact-match miss", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const model = createMockLanguageModelV4((options) => {
      signals.push(options.abortSignal);
      return Promise.resolve(mockLanguageModelV4Text("yes"));
    });

    await expect(
      withSemanticScore(model, resultWithMisses(2, 3))
    ).resolves.toEqual(expect.objectContaining({ semanticCorrect: 5 }));

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
  });

  it.each(["yesterday", "yes, but the value differs"])(
    "does not recover a miss from non-exact judge response %j",
    async (text) => {
      const model = createMockLanguageModelV4(() =>
        Promise.resolve(mockLanguageModelV4Text(text))
      );

      await expect(
        withSemanticScore(model, resultWithMisses(1, 2))
      ).resolves.toEqual(expect.objectContaining({ semanticCorrect: 2 }));
    }
  );

  it("preserves the exact-match score after an arbitrary judge rejection", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.reject({ code: "judge-offline" })
    );

    await expect(
      withSemanticScore(model, resultWithMisses(1, 2))
    ).resolves.toEqual(expect.objectContaining({ semanticCorrect: 2 }));
  });

  it("removes its deadline listener after normal provider settlement", async () => {
    const controller = new AbortController();
    const baseline = getEventListeners(controller.signal, "abort").length;
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("no"))
    );

    await withSemanticScore(model, resultWithMisses(1), controller.signal);

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(
      baseline
    );
  });

  it("settles at the shared deadline when a provider ignores cancellation", async () => {
    const controller = new AbortController();
    const provider = new EventTarget();
    const started = new Promise<void>((resolve) => {
      provider.addEventListener("started", () => resolve(), { once: true });
    });
    const model = createMockLanguageModelV4(() => {
      provider.dispatchEvent(new Event("started"));
      return new Promise(() => undefined);
    });

    const scoring = withSemanticScore(
      model,
      resultWithMisses(1, 2),
      controller.signal
    );
    await started;
    controller.abort();

    await expect(scoring).resolves.toEqual(
      expect.objectContaining({ semanticCorrect: 2 })
    );
  });

  it("contains a provider rejection that arrives after deadline settlement", async () => {
    const controller = new AbortController();
    const provider = new EventTarget();
    const started = new Promise<void>((resolve) => {
      provider.addEventListener("started", () => resolve(), { once: true });
    });
    let rejectProvider: ((reason?: unknown) => void) | undefined;
    const providerResult = new Promise<
      ReturnType<typeof mockLanguageModelV4Text>
    >((_, reject) => {
      rejectProvider = reject;
    });
    const model = createMockLanguageModelV4(() => {
      provider.dispatchEvent(new Event("started"));
      return providerResult;
    });
    const scoring = withSemanticScore(
      model,
      resultWithMisses(1, 2),
      controller.signal
    );
    await started;
    controller.abort();
    await expect(scoring).resolves.toEqual(
      expect.objectContaining({ semanticCorrect: 2 })
    );
    const lateRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      lateRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      rejectProvider?.({ code: "late-provider-failure" });
      await setImmediate();
      expect(lateRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
