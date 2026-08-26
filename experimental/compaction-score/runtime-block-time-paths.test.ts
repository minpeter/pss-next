import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { createDeterministicRuntimeBlockModel } from "./runtime-block-time-deterministic";
import { isCompactionProviderPrompt } from "./runtime-block-time-instrumentation";
import { calculateRuntimeBlockTrial } from "./runtime-block-time-metrics";
import { validateRuntimeBlockPath } from "./runtime-block-time-paths";
import { runRuntimeBlockTrial } from "./runtime-block-time-runner";
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
  it("classifies an applied candidate after summary wrapper prose changes", () => {
    const result = validateRuntimeBlockPath({
      providerStartedSequence: 2,
      scenario: "prepared-hit",
      spans: [
        {
          endedAtMs: 10,
          endedSequence: 1,
          kind: "summary",
          startedAtMs: 0,
          startedSequence: 1,
          status: "completed",
        },
      ],
      targetPrompt: [
        {
          content: [
            {
              text: "Earlier context is represented structurally below.\n<summary>\ncompact handoff\n</summary>",
              type: "text",
            },
          ],
          role: "user",
        },
      ],
    });

    expect(result.candidateApplied).toBe(true);
  });

  it.each(
    (
      [
        "overlap-nonblocking",
        "prepared-hit",
        "candidate-fit-late-hit",
        "candidate-fit-hard-block",
        "summary-failure-retry-hit",
        "repeated-failure-overflow-recovery",
      ] as const
    ).flatMap((scenario) =>
      [1, 2].map((repetition) => ({ repetition, scenario }))
    )
  )(
    "validates the $scenario runtime path at repetition $repetition",
    async ({ repetition, scenario }) => {
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
        repetition,
        scenario,
        summaryTimeOffsetMs: deterministic.summaryTimeOffsetMs,
      });

      expect(observation.candidateApplied).toBe(
        scenario !== "overlap-nonblocking"
      );
      expect(observation.summarySpans.map((span) => span.status)).toEqual(
        {
          "candidate-fit-hard-block": ["completed"],
          "candidate-fit-late-hit": ["completed"],
          "overlap-nonblocking": ["completed"],
          "prepared-hit": ["completed"],
          "repeated-failure-overflow-recovery": ["error", "error", "completed"],
          "summary-failure-retry-hit": ["error", "completed"],
        }[scenario]
      );
    }
  );

  it("keeps the in-flight candidate hard block causal at a tied timestamp", async () => {
    let logicalNow = 0;
    const deterministic = createDeterministicRuntimeBlockModel(
      "candidate-fit-hard-block",
      (milliseconds) => {
        logicalNow += milliseconds;
      }
    );
    const scenarioModel = createRuntimeBlockScenarioModel(
      deterministic.model,
      "candidate-fit-hard-block"
    );

    const observation = await runRuntimeBlockTrial({
      model: scenarioModel.model,
      now: () => logicalNow,
      onTargetStepStart: deterministic.onTargetStepStart,
      repetition: 1,
      scenario: "candidate-fit-hard-block",
      summaryTimeOffsetMs: deterministic.summaryTimeOffsetMs,
    });

    expect(observation.targetProviderStartedAtMs).toBe(180);
    expect(observation.summarySpans).toEqual([
      {
        endedAtMs: 180,
        kind: "summary",
        startedAtMs: 0,
        status: "completed",
      },
    ]);
  });

  it("attributes zero user block when target dispatch overlaps the summary", async () => {
    let logicalNow = 0;
    const deterministic = createDeterministicRuntimeBlockModel(
      "overlap-nonblocking",
      (milliseconds) => {
        logicalNow += milliseconds;
      }
    );
    const scenarioModel = createRuntimeBlockScenarioModel(
      deterministic.model,
      "overlap-nonblocking"
    );

    const observation = await runRuntimeBlockTrial({
      model: scenarioModel.model,
      now: () => logicalNow,
      onTargetStepStart: deterministic.onTargetStepStart,
      repetition: 1,
      scenario: "overlap-nonblocking",
      summaryTimeOffsetMs: deterministic.summaryTimeOffsetMs,
    });
    const trial = calculateRuntimeBlockTrial(observation);

    expect(trial.overlapAtProviderStart).toBe(true);
    expect(trial.treatmentProviderDispatchMs).toBe(0);
    expect(trial.userBlockMs).toBe(0);
    expect(trial.zeroBlock).toBe(true);
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
    expect(JSON.stringify(targetPrompt)).not.toContain("<summary>");
  });

  it("records one failed summary followed by a background retry hit", async () => {
    let summaryCalls = 0;
    const model = createMockLanguageModelV4(({ prompt }) => {
      if (isCompactionProviderPrompt(prompt)) {
        summaryCalls += 1;
        if (summaryCalls === 1) {
          throw new TypeError("injected summary failure");
        }
        return Promise.resolve(mockLanguageModelV4Text("recovered handoff"));
      }
      return Promise.resolve(mockLanguageModelV4Text("DONE"));
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
