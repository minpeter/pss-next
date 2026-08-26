import { describe, expect, it } from "vitest";
import type { FixtureQuestion } from "./fixture";
import { summarizeTrials, type TrialRecord } from "./report";
import { scoreAnswers } from "./scorer";

const SHA256_PATTERN = /^[a-f\d]{64}$/;

const questions: FixtureQuestion[] = [
  {
    answer: "alpha",
    category: "exact-recall",
    question: "First value?",
  },
  {
    answer: "beta",
    category: "tool-history",
    question: "Second value?",
  },
];

const scored = (compactedSecond: string) =>
  scoreAnswers(
    questions,
    new Map([
      [questions[0], "alpha"],
      [questions[1], "beta"],
    ]),
    new Map([
      [questions[0], "alpha"],
      [questions[1], compactedSecond],
    ])
  );

const validTrial = (
  id: string,
  compactedSecond: string,
  summaryTokens: number
): TrialRecord => ({
  hops: [
    {
      endSeqExclusive: 80,
      prefixTokens: 1000,
      sentOutputTokens: summaryTokens,
      summaryTokens,
    },
  ],
  fixtureSeed: "fixture-a",
  id,
  prefixTokens: 1000,
  repetition: 1,
  scenario: id === "two" ? "lifecycle" : "baseline",
  score: scored(compactedSecond),
  status: "valid",
  summaryTokens,
});

describe("summarizeTrials", () => {
  it("excludes invalid trials and reports compacted-arm distribution", () => {
    const records: TrialRecord[] = [
      validTrial("one", "beta", 250),
      validTrial("two", "unknown", 500),
      {
        error: "provider saturated",
        fixtureSeed: "fixture-b",
        id: "three",
        repetition: 1,
        scenario: "boundary-noise",
        status: "evaluation-provider-failure",
      },
    ];

    const report = summarizeTrials(records);

    expect(report.retention).not.toBeNull();
    expect(report.compression).not.toBeNull();
    if (!(report.retention && report.compression)) {
      return;
    }
    expect(report.trials).toEqual({
      attempted: 3,
      invalidByStatus: { "evaluation-provider-failure": 1 },
      valid: 2,
    });
    expect(report.retention.aggregate).toMatchObject({
      correct: 3,
      total: 4,
    });
    expect(report.retention.trialAccuracy).toEqual({
      max: 1,
      mean: 0.75,
      min: 0.5,
      quantiles: { p50: 0.75, p95: 0.975 },
      standardDeviation: 0.25,
    });
    expect(report.compression.ratio).toEqual({
      max: 0.5,
      mean: 0.375,
      min: 0.25,
      quantiles: { p50: 0.375, p95: 0.4875 },
      standardDeviation: 0.125,
    });
    expect(report.compression).toMatchObject({
      byScenario: expect.arrayContaining([
        {
          ratio: expect.objectContaining({ mean: 0.25 }),
          scenario: "baseline",
        },
        {
          ratio: expect.objectContaining({ mean: 0.5 }),
          scenario: "lifecycle",
        },
      ]),
    });
    expect(report.retention).toMatchObject({
      disagreements: [
        expect.objectContaining({
          arm: "compacted",
          category: "tool-history",
          count: 1,
          fingerprint: expect.stringMatching(SHA256_PATTERN),
          scenario: "lifecycle",
        }),
      ],
    });
    expect(report.retention.byScenario).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accuracy: 1,
          scenario: "baseline",
        }),
        expect.objectContaining({
          accuracy: 0.5,
          scenario: "lifecycle",
        }),
      ])
    );
    expect(report.compression.byHop).toEqual([
      expect.objectContaining({ hop: 1 }),
    ]);
  });

  it("returns null statistics when no trial is valid", () => {
    expect(
      summarizeTrials([
        {
          error: "bad JSON",
          fixtureSeed: "fixture-a",
          id: "one",
          repetition: 1,
          scenario: "baseline",
          status: "protocol-failure",
        },
      ])
    ).toMatchObject({
      compression: null,
      retention: null,
      trials: {
        attempted: 1,
        invalidByStatus: { "protocol-failure": 1 },
        valid: 0,
      },
    });
  });
});
