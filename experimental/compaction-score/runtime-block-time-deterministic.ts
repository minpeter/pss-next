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
} {
  const firstSummaryRelease = deferred();
  let firstSummaryReleased = false;
  let summaryCalls = 0;
  const model = createMockLanguageModelV4(async ({ prompt }) => {
    if (isCompactionProviderPrompt(prompt)) {
      summaryCalls += 1;
      if (summaryCalls === 1) {
        if (
          scenario === "overlap-nonblocking" ||
          scenario === "candidate-fit-hard-block"
        ) {
          await firstSummaryRelease.promise;
        }
        advance(100);
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
      advance(1);
      firstSummaryRelease.resolve();
    }
    return mockLanguageModelV4Text("DONE");
  });
  return {
    model,
    onTargetStepStart:
      scenario === "candidate-fit-hard-block"
        ? () => {
            advance(80);
            firstSummaryRelease.resolve();
          }
        : undefined,
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
