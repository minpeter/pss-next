import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { createDeterministicRuntimeBlockModel } from "./runtime-block-time-deterministic";
import {
  isCompactionProviderPrompt,
  runRuntimeBlockTrial,
} from "./runtime-block-time-runner";
import { createRuntimeBlockScenarioModel } from "./runtime-block-time-scenario-model";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
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

describe("runtime block-time path validity", () => {
  it.each([
    "prepared-hit",
    "candidate-fit-late-hit",
    "candidate-too-broad-fallback",
    "summary-failure-retry-hit",
    "repeated-failure-overflow-recovery",
  ] as const)("validates the %s runtime path", async (scenario) => {
    let logicalNow = 0;
    const deterministic = createDeterministicRuntimeBlockModel(
      scenario,
      (milliseconds) => {
        logicalNow += milliseconds;
      }
    );
    const scenarioModel = createRuntimeBlockScenarioModel(
      deterministic.model,
      scenario
    );

    const observation = await runRuntimeBlockTrial({
      model: scenarioModel.model,
      now: () => logicalNow,
      onTargetStepStart: deterministic.onTargetStepStart,
      repetition: 1,
      scenario,
    });

    expect(observation.pathValid).toBe(true);
    expect(observation.candidateApplied).toBe(true);
    expect(observation.summarySpans.map((span) => span.status)).toEqual(
      {
        "candidate-fit-late-hit": ["completed"],
        "candidate-too-broad-fallback": ["completed", "completed"],
        "prepared-hit": ["completed"],
        "repeated-failure-overflow-recovery": ["error", "error", "completed"],
        "summary-failure-retry-hit": ["error", "completed"],
      }[scenario]
    );
  });

  it("does not classify mere summary overlap as a prepared hit", async () => {
    const summaryRelease = deferred();
    let foregroundCalls = 0;
    let targetPrompt: MockLanguageModelV4CallOptions["prompt"] = [];
    const model = createMockLanguageModelV4(async ({ prompt }) => {
      if (isCompactionProviderPrompt(prompt)) {
        await summaryRelease.promise;
        return mockLanguageModelV4Text("compact handoff");
      }
      foregroundCalls += 1;
      if (foregroundCalls === 3) {
        targetPrompt = prompt;
        summaryRelease.resolve();
      }
      return mockLanguageModelV4Text("DONE");
    });

    const observation = await runRuntimeBlockTrial({
      model,
      repetition: 1,
      scenario: "overlap-nonblocking",
    });

    expect(observation.candidateApplied).toBe(false);
    expect(JSON.stringify(targetPrompt)).not.toContain(
      "The conversation history before this point was compacted"
    );
  });

  it("records one failed summary followed by a background retry hit", async () => {
    let summaryCalls = 0;
    const model = createMockLanguageModelV4(({ prompt }) => {
      if (isCompactionProviderPrompt(prompt)) {
        summaryCalls += 1;
        if (summaryCalls === 1) {
          throw new TypeError("injected summary failure");
        }
        return mockLanguageModelV4Text("recovered handoff");
      }
      return mockLanguageModelV4Text("DONE");
    });

    const observation = await runRuntimeBlockTrial({
      model,
      repetition: 1,
      scenario: "summary-failure-retry-hit",
    });

    expect(observation.summarySpans.map((span) => span.status)).toEqual([
      "error",
      "completed",
    ]);
  });
});
