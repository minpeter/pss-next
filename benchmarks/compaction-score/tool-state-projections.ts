import type { CompactionFixture, FixtureQuestion } from "./fixture";
import { buildToolStateCjkFixture } from "./tool-state-cjk-fixture";

export function buildEvolvingToolStateFixture(seed: string): CompactionFixture {
  return project(
    seed,
    "evolving-tool-state",
    ({ category }) => category === "tool-history"
  );
}

export function buildActualCjkFixture(seed: string): CompactionFixture {
  return project(
    seed,
    "actual-cjk",
    ({ category }) => category !== "tool-history"
  );
}

function project(
  seed: string,
  scenario: CompactionFixture["scenario"],
  includes: (question: FixtureQuestion) => boolean
): CompactionFixture {
  const source = buildToolStateCjkFixture(seed);
  return {
    ...source,
    questions: source.questions.filter(includes),
    scenario,
  };
}
