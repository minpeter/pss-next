import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import {
  isCompactionProviderPrompt,
  type RuntimeBlockLanguageModel,
} from "./runtime-block-time-instrumentation";
import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

export function createDeterministicRuntimeBlockModel(
  scenario: RuntimeBlockScenario,
  advance: (milliseconds: number) => void
): {
  readonly model: RuntimeBlockLanguageModel;
  readonly onTargetStepStart: (() => void) | undefined;
  readonly summaryTimeOffsetMs: () => number;
} {
  const firstSummaryRelease = deferred();
  let concurrentSummaryServiceMs = 0;
  let firstSummaryReleased = false;
  let summaryCalls = 0;
  const model = createMockLanguageModelV4(async ({ prompt }) => {
    if (isCompactionProviderPrompt(prompt)) {
      summaryCalls += 1;
      if (summaryCalls === 1) {
        if (
          scenario === "overlap-nonblocking" ||
          scenario === "candidate-fit-hard-block" ||
          scenario === "candidate-too-broad-fallback"
        ) {
          await firstSummaryRelease.promise;
        }
        if (scenario === "overlap-nonblocking") {
          concurrentSummaryServiceMs += 100;
        } else {
          advance(100);
        }
      } else {
        advance(30);
      }
      return mockLanguageModelV4Text("compact handoff");
    }
    if (
      scenario === "overlap-nonblocking" &&
      summaryCalls === 1 &&
      !firstSummaryReleased
    ) {
      firstSummaryReleased = true;
      firstSummaryRelease.resolve();
    }
    return mockLanguageModelV4Text("DONE");
  });
  return {
    model,
    onTargetStepStart:
      scenario === "candidate-fit-hard-block" ||
      scenario === "candidate-too-broad-fallback"
        ? () => {
            advance(80);
            firstSummaryRelease.resolve();
          }
        : undefined,
    summaryTimeOffsetMs: () => concurrentSummaryServiceMs,
  };
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}
