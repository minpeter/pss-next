import { describe, expect, it } from "vitest";
import { buildCompactionFixture } from "./fixture";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { runCompactionTrial } from "./trial-runner";

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
    expect(record.hops[0]?.sentOutputTokens).toBe(768);
    expect(calls).toHaveLength(3);
    expect(
      calls.filter((call) => call.maxOutputTokens === undefined)
    ).toHaveLength(2);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          maxOutputTokens: 768,
          seed: 42,
          temperature: 0,
        }),
      ])
    );
  });

  it("caps the assembled summary including deterministic tool evidence", async () => {
    const model = createMockLanguageModelV4([
      mockLanguageModelV4Text("x".repeat(4000)),
      mockLanguageModelV4Text(answerJson()),
      mockLanguageModelV4Text(answerJson()),
    ]);

    const record = await runCompactionTrial({
      attempt: 1,
      enforceSummaryOutputBudget: true,
      fixture,
      fixtureSeed: "trial-runner-test",
      id: "trial-hard-cap",
      model,
      repetition: 1,
      summaryMaxOutputTokens: 64,
    });

    expect(record.status).toBe("valid");
    if (record.status !== "valid") {
      return;
    }
    expect(record.hops[0]?.summaryTokens).toBeLessThanOrEqual(64);
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
});
