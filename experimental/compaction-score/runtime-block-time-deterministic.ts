import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";
import {
  isCompactionProviderPrompt,
  type RuntimeBlockLanguageModel,
} from "./runtime-block-time-runner";

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
  let foregroundCalls = 0;
  let summaryCalls = 0;
  const model = createMockLanguageModelV4(async ({ prompt }) => {
    if (isCompactionProviderPrompt(prompt)) {
      summaryCalls += 1;
      if (summaryCalls === 1) {
        if (scenario !== "prepared-hit") {
          await firstSummaryRelease.promise;
        }
        advance(100);
      } else {
        advance(30);
      }
      return mockLanguageModelV4Text("compact handoff");
    }
    foregroundCalls += 1;
    if (scenario === "overlap-nonblocking" && foregroundCalls === 3) {
      advance(1);
      firstSummaryRelease.resolve();
    }
    return mockLanguageModelV4Text("DONE");
  });
  return {
    model,
    onTargetStepStart:
      scenario === "late-overflow-miss" ||
      scenario === "summary-failure-recovery"
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
