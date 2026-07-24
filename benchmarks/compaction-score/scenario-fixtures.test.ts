import { createHash } from "node:crypto";
import { estimateModelMessagesTokens } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { BENCHMARK_SCENARIOS, buildScenarioFixture } from "./scenario-fixtures";

const CHARACTERIZED_FIXTURES = [
  {
    compactionEnds: [84],
    digest: "12bfa6e0a364d975a89b6e9eef47cca4a858051e1f8387aa065480ebf19f4eb4",
    messages: 92,
    questions: 24,
    scenario: "baseline",
    seed: "goal2-baseline",
  },
  {
    compactionEnds: [26, 50],
    digest: "a77bc8f4b01b351921cbe9d3e4846942ca6502a36607c699326939e2a65588a6",
    messages: 56,
    questions: 17,
    scenario: "lifecycle",
    seed: "goal2-lifecycle",
  },
  {
    compactionEnds: [36],
    digest: "eedee80d9ba652dc39d5b4ec568da500f9140747594aa9060e5376c1f693612c",
    messages: 42,
    questions: 11,
    scenario: "boundary-noise",
    seed: "goal2-boundary",
  },
] as const;

describe("benchmark scenario registry", () => {
  it("covers existing families plus long-session retention", () => {
    expect(BENCHMARK_SCENARIOS).toEqual([
      "baseline",
      "lifecycle",
      "boundary-noise",
      "long-session",
      "progressive-five-hop",
    ]);
  });

  it.each(CHARACTERIZED_FIXTURES)(
    "preserves $scenario fixture bytes and metadata",
    ({ compactionEnds, digest, messages, questions, scenario, seed }) => {
      const fixture = buildScenarioFixture(scenario, seed);
      const serialized = JSON.stringify({ ...fixture, seed });

      expect(fixture.messages).toHaveLength(messages);
      expect(fixture.questions).toHaveLength(questions);
      expect(fixture.compactionEnds).toEqual(compactionEnds);
      expect(fixture.scenario).toBe(scenario);
      expect(createHash("sha256").update(serialized).digest("hex")).toBe(
        digest
      );
    }
  );

  it.each(BENCHMARK_SCENARIOS)(
    "%s has increasing tool-safe compaction boundaries",
    (scenario) => {
      const fixture = buildScenarioFixture(scenario, `invariant-${scenario}`);

      expect(fixture.scenario).toBe(scenario);
      expect(fixture.compactionEnds.length).toBeGreaterThan(0);
      expect(fixture.compactionEnds).toEqual(
        [...fixture.compactionEnds].sort((left, right) => left - right)
      );
      for (const end of fixture.compactionEnds) {
        expect(fixture.messages[end - 1]?.role).toBe("assistant");
        expect(fixture.messages[end]?.role).toBe("user");
      }
    }
  );

  it("lifecycle chains two summaries across corrections and retractions", () => {
    const fixture = buildScenarioFixture("lifecycle", "lifecycle-invariant");
    const categories = new Set(
      fixture.questions.map(({ category }) => category)
    );

    expect(fixture.compactionEnds).toHaveLength(2);
    for (const category of [
      "constraint-retention",
      "file-state",
      "hallucination-resistance",
      "negative-knowledge",
      "temporal-resolution",
    ] as const) {
      expect(categories.has(category)).toBe(true);
    }
  });

  it("boundary-noise creates real budget pressure around tool-only facts", () => {
    const fixture = buildScenarioFixture("boundary-noise", "noise-invariant");
    const end = fixture.compactionEnds.at(-1) ?? 0;
    const prefixTokens = estimateModelMessagesTokens(
      fixture.messages.slice(0, end)
    );

    expect(prefixTokens).toBeGreaterThan(5000);
    expect(
      fixture.questions.some(({ category }) => category === "boundary-recall")
    ).toBe(true);
  });
});
