import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import {
  isCompactionProviderPrompt,
  runtimeBlockEstimator,
  runtimeBlockInput,
} from "./runtime-block-time-instrumentation";
import {
  calculateRuntimeBlockTrial,
  type RuntimeBlockObservation,
  type RuntimeBlockScenario,
} from "./runtime-block-time-metrics";
import { createRuntimeBlockTimeReport } from "./runtime-block-time-report";
import { runRuntimeBlockTrial } from "./runtime-block-time-runner";

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

describe("runtime block-time metrics", () => {
  it("subtracts matched control TTFV from treatment TTFV", () => {
    const observation: RuntimeBlockObservation = {
      candidateApplied: false,
      controlFirstVisibleAtMs: 116,
      controlProviderStartedAtMs: 111,
      controlSentAtMs: 100,
      controlStepStartedAtMs: 105,
      repetition: 1,
      scenario: "overlap-nonblocking",
      summarySpans: [
        {
          endedAtMs: 200,
          kind: "summary",
          startedAtMs: 100,
          status: "completed",
        },
      ],
      targetFirstVisibleAtMs: 140,
      targetProviderStartedAtMs: 128,
      targetSentAtMs: 110,
      targetStepStartedAtMs: 120,
    };

    expect(calculateRuntimeBlockTrial(observation)).toMatchObject({
      avoidedBlockMs: 86,
      blockAvoidanceRatio: 0.86,
      candidateApplied: false,
      controlPreparationMs: 6,
      controlProviderDispatchMs: 11,
      controlTtfvMs: 16,
      gateDeltaMs: 2,
      overlapAtProviderStart: true,
      preStepDeltaMs: 5,
      summaryCalls: 1,
      summaryServiceMs: 100,
      treatmentPreparationMs: 8,
      treatmentProviderDispatchMs: 18,
      treatmentTtfvMs: 30,
      userDeltaMs: 14,
      userBlockMs: 14,
      zeroBlock: false,
    });
  });

  it("counts only exact benchmark inputs, never provider-written summaries", () => {
    expect(
      runtimeBlockEstimator({
        messages: [
          {
            content: runtimeBlockInput(700),
            role: "user",
          },
          {
            content:
              "Summary preserved [PSS_BLOCK_BENCH_UNITS=700] from history.",
            role: "user",
          },
          { content: "DONE", role: "assistant" },
        ],
      })
    ).toBe(750);
  });

  it("persists raw observations beside derived trials for independent audit", () => {
    const observation: RuntimeBlockObservation = {
      candidateApplied: false,
      controlFirstVisibleAtMs: 116,
      controlProviderStartedAtMs: 111,
      controlSentAtMs: 100,
      controlStepStartedAtMs: 105,
      repetition: 1,
      scenario: "overlap-nonblocking",
      summarySpans: [
        {
          endedAtMs: 200,
          kind: "summary",
          startedAtMs: 100,
          status: "completed",
        },
      ],
      targetFirstVisibleAtMs: 140,
      targetProviderStartedAtMs: 128,
      targetSentAtMs: 110,
      targetStepStartedAtMs: 120,
    };
    const hit = calculateRuntimeBlockTrial(observation);
    const scenarios: readonly RuntimeBlockScenario[] = [
      "overlap-nonblocking",
      "prepared-hit",
      "candidate-fit-late-hit",
      "candidate-fit-hard-block",
      "summary-failure-retry-hit",
      "repeated-failure-overflow-recovery",
    ];
    const trials = scenarios.map((scenario) => ({ ...hit, scenario }));

    const report = createRuntimeBlockTimeReport({
      mode: "deterministic",
      model: "mock",
      observations: [observation],
      trials,
    });

    expect(report).toMatchObject({ observations: [observation] });
  });

  it("observes nonblocking overlap without applying the candidate", async () => {
    const summaryRelease = deferred();
    const targetProviderCalled = deferred();
    let foregroundCalls = 0;
    const model = createMockLanguageModelV4(async ({ prompt }) => {
      if (isCompactionProviderPrompt(prompt)) {
        await summaryRelease.promise;
        return mockLanguageModelV4Text("compact handoff");
      }
      foregroundCalls += 1;
      if (foregroundCalls === 3) {
        targetProviderCalled.resolve();
      }
      return mockLanguageModelV4Text("DONE");
    });

    const observationPromise = runRuntimeBlockTrial({
      model,
      repetition: 1,
      scenario: "overlap-nonblocking",
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      targetProviderCalled.promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new TypeError("target provider was not called")),
          1000
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    summaryRelease.resolve();
    const observation = await observationPromise;
    const trial = calculateRuntimeBlockTrial(observation);

    expect(Object.isFrozen(observation.summarySpans)).toBe(true);
    expect(observation.summarySpans.every(Object.isFrozen)).toBe(true);
    expect(trial.overlapAtProviderStart).toBe(true);
    expect(trial.summaryCalls).toBe(1);
  });

  it("attributes only the fitting candidate that blocks target dispatch", async () => {
    const firstSummaryRelease = deferred();
    let summaryCalls = 0;
    const model = createMockLanguageModelV4(async ({ prompt }) => {
      if (isCompactionProviderPrompt(prompt)) {
        summaryCalls += 1;
        if (summaryCalls === 1) {
          await firstSummaryRelease.promise;
        }
        return mockLanguageModelV4Text("compact handoff");
      }
      return mockLanguageModelV4Text("DONE");
    });

    const observation = await runRuntimeBlockTrial({
      model,
      onTargetStepStart: () => firstSummaryRelease.resolve(),
      repetition: 1,
      scenario: "candidate-fit-hard-block",
    });
    const trial = calculateRuntimeBlockTrial(observation);

    expect(trial.overlapAtProviderStart).toBe(false);
    expect(trial.summaryCalls).toBe(1);
  });

  it("rejects a target turn that reaches the provider but ends in error", async () => {
    let foregroundCalls = 0;
    const model = createMockLanguageModelV4(({ prompt }) => {
      if (isCompactionProviderPrompt(prompt)) {
        return Promise.resolve(mockLanguageModelV4Text("compact handoff"));
      }
      foregroundCalls += 1;
      if (foregroundCalls === 3) {
        throw new Error("target provider failed");
      }
      return Promise.resolve(mockLanguageModelV4Text("DONE"));
    });

    await expect(
      runRuntimeBlockTrial({
        model,
        repetition: 1,
        scenario: "overlap-nonblocking",
      })
    ).rejects.toThrow("turn-error");
  });

  it("counterbalances treatment and control order by repetition parity", async () => {
    const callKinds: ("foreground" | "summary")[] = [];
    const model = createMockLanguageModelV4(({ prompt }) => {
      callKinds.push(
        isCompactionProviderPrompt(prompt) ? "summary" : "foreground"
      );
      return Promise.resolve(mockLanguageModelV4Text("DONE"));
    });

    await runRuntimeBlockTrial({
      model,
      repetition: 1,
      scenario: "prepared-hit",
    });
    const oddSummaryIndex = callKinds.indexOf("summary");
    callKinds.length = 0;
    await runRuntimeBlockTrial({
      model,
      repetition: 2,
      scenario: "prepared-hit",
    });

    expect(oddSummaryIndex).toBe(2);
    expect(callKinds.indexOf("summary")).toBe(5);
  });
});
