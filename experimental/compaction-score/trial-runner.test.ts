import {
  CompactionSummaryNotSmallerError,
  compactionContextForModel,
  estimateModelMessagesTokens,
} from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { buildCompactionFixture } from "./fixture";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { classifySummaryFailure, runCompactionTrial } from "./trial-runner";

const fixture = buildCompactionFixture("trial-runner-test");

const answerJson = (wrongIndex?: number): string =>
  JSON.stringify({
    answers: fixture.questions.map((question, index) => ({
      answer: index === wrongIndex ? "unknown" : question.answer,
      id: `q${index}`,
    })),
  });

describe("runCompactionTrial", () => {
  it("uses three deterministic calls and returns compacted-only accuracy", async () => {
    const calls: MockLanguageModelV4CallOptions[] = [];
    const outputs = [
      mockLanguageModelV4Text("structured summary"),
      mockLanguageModelV4Text(answerJson()),
      mockLanguageModelV4Text(answerJson(0)),
    ];
    const model = createMockLanguageModelV4((options) => {
      calls.push(options);
      return Promise.resolve(outputs[calls.length - 1] ?? outputs[0]);
    });

    const record = await runCompactionTrial({
      attempt: 1,
      fixture,
      fixtureSeed: "trial-runner-test",
      id: "trial-1",
      model,
      repetition: 1,
      seed: 42,
      summaryMaxOutputTokens: 768,
    });

    expect(record.status).toBe("valid");
    if (record.status !== "valid") {
      return;
    }
    expect(record.score.headline).toEqual({ correct: 23, total: 24 });
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          maxOutputTokens: 768,
          seed: 42,
          temperature: 0,
        }),
        expect.objectContaining({
          maxOutputTokens: 4096,
          seed: 42,
          temperature: 0,
        }),
      ])
    );
  });

  it("omits seeds for providers that do not support them", async () => {
    const calls: MockLanguageModelV4CallOptions[] = [];
    const outputs = [
      mockLanguageModelV4Text("structured summary"),
      mockLanguageModelV4Text(answerJson()),
      mockLanguageModelV4Text(answerJson()),
    ];
    const model = createMockLanguageModelV4((options) => {
      calls.push(options);
      return Promise.resolve(outputs[calls.length - 1] ?? outputs[0]);
    });

    const record = await runCompactionTrial({
      attempt: 1,
      fixture,
      fixtureSeed: "trial-runner-test",
      id: "trial-without-seed",
      model,
      repetition: 1,
      summaryMaxOutputTokens: 768,
    });

    expect(record.status).toBe("valid");
    expect(calls).toHaveLength(3);
    expect(calls.every(({ seed }) => seed === undefined)).toBe(true);
  });

  it("routes a named prompt profile through the production summary path", async () => {
    const calls: MockLanguageModelV4CallOptions[] = [];
    const outputs = [
      mockLanguageModelV4Text("structured summary"),
      mockLanguageModelV4Text(answerJson()),
      mockLanguageModelV4Text(answerJson()),
    ];
    const model = createMockLanguageModelV4((options) => {
      calls.push(options);
      return Promise.resolve(outputs[calls.length - 1] ?? outputs[0]);
    });
    const profile = {
      hash: "sha256:profile-sentinel",
      id: "senpi-profile-sentinel",
    };

    const record = await runCompactionTrial({
      attempt: 1,
      fixture,
      fixtureSeed: "trial-runner-test",
      id: "trial-with-profile",
      model,
      profile,
      repetition: 1,
      seed: 43,
      summaryInstructions: "PROFILE_INSTRUCTION_SENTINEL",
      summaryMaxOutputTokens: 768,
    });

    expect(JSON.stringify(calls[0]?.prompt)).toContain(
      "PROFILE_INSTRUCTION_SENTINEL"
    );
    expect(record).toMatchObject({ profile, status: "valid" });
  });

  it("invalidates a trial when the full-context arm misses", async () => {
    const model = createMockLanguageModelV4([
      mockLanguageModelV4Text("structured summary"),
      mockLanguageModelV4Text(answerJson(0)),
      mockLanguageModelV4Text(answerJson()),
    ]);

    await expect(
      runCompactionTrial({
        attempt: 1,
        fixture,
        fixtureSeed: "trial-runner-test",
        id: "trial-2",
        model,
        repetition: 1,
        seed: 43,
        summaryMaxOutputTokens: 768,
      })
    ).resolves.toMatchObject({ status: "invalid-full-control" });
  });

  it("separates malformed answer JSON from compaction misses", async () => {
    const model = createMockLanguageModelV4([
      mockLanguageModelV4Text("structured summary"),
      mockLanguageModelV4Text(answerJson()),
      mockLanguageModelV4Text("not json"),
    ]);

    await expect(
      runCompactionTrial({
        attempt: 1,
        fixture,
        fixtureSeed: "trial-runner-test",
        id: "trial-3",
        model,
        repetition: 1,
        seed: 44,
        summaryMaxOutputTokens: 768,
      })
    ).resolves.toMatchObject({ status: "protocol-failure" });
  });

  it("chains previous summaries through every configured compaction hop", async () => {
    const safeFirstEnd = fixture.messages.findIndex(
      (message, index) =>
        index > 10 &&
        message.role === "user" &&
        fixture.messages[index - 1]?.role === "assistant" &&
        typeof fixture.messages[index - 1]?.content === "string"
    );
    const chainedFixture = {
      ...fixture,
      compactionEnds: [
        safeFirstEnd,
        fixture.compactionEnds.at(-1) ?? fixture.messages.length - 8,
      ],
      scenario: "lifecycle" as const,
    };
    const calls: MockLanguageModelV4CallOptions[] = [];
    const outputs = [
      mockLanguageModelV4Text("first summary"),
      mockLanguageModelV4Text("second summary"),
      mockLanguageModelV4Text(answerJson()),
      mockLanguageModelV4Text(answerJson()),
    ];
    const model = createMockLanguageModelV4((options) => {
      calls.push(options);
      return Promise.resolve(outputs[calls.length - 1] ?? outputs[0]);
    });

    const record = await runCompactionTrial({
      attempt: 1,
      fixture: chainedFixture,
      fixtureSeed: "trial-runner-test",
      id: "trial-4",
      model,
      repetition: 1,
      seed: 45,
      summaryMaxOutputTokens: 768,
    });

    expect(record.status).toBe("valid");
    if (record.status !== "valid") {
      return;
    }
    expect(calls).toHaveLength(4);
    expect(record.hops).toHaveLength(2);
    expect(record.hops.map(({ endSeqExclusive }) => endSeqExclusive)).toEqual(
      chainedFixture.compactionEnds
    );
    expect(record.hops.map(({ prefixTokens }) => prefixTokens)).toEqual(
      chainedFixture.compactionEnds.map((endSeqExclusive) =>
        estimateModelMessagesTokens(
          chainedFixture.messages.slice(0, endSeqExclusive)
        )
      )
    );
    expect(
      record.hops.every(
        ({ summarizerInputTokens }) =>
          summarizerInputTokens !== undefined && summarizerInputTokens > 0
      )
    ).toBe(true);
    expect(record.hops[0]?.summaryTokens).toBe(
      estimateModelMessagesTokens([
        compactionContextForModel({
          endSeqExclusive: safeFirstEnd,
          role: "compaction",
          startSeq: 0,
          summary: "first summary",
        }),
      ])
    );
  });

  it("classifies an expanding summary separately from provider failures", () => {
    expect(
      classifySummaryFailure(
        new CompactionSummaryNotSmallerError("summary expanded")
      )
    ).toBe("non-compressing-summary");
    expect(classifySummaryFailure(new Error("provider down"))).toBe(
      "summary-provider-failure"
    );
  });
});
