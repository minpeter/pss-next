import type { FixtureQuestion } from "./fixture";

export type ScoreArm = "compacted" | "full";

export interface ScoreCount {
  readonly correct: number;
  readonly total: number;
}

export interface CategoryScore extends ScoreCount {
  readonly category: FixtureQuestion["category"];
}

export interface ArmScore {
  readonly overall: ScoreCount;
  readonly perCategory: readonly CategoryScore[];
}

export interface ScoreDisagreement {
  readonly actual: string;
  readonly arm: ScoreArm;
  readonly category: FixtureQuestion["category"];
  readonly expected: string;
  readonly question: string;
}

export interface CompactionScore {
  readonly arms: {
    readonly compacted: ArmScore;
    readonly full: ArmScore;
  };
  readonly disagreements: readonly ScoreDisagreement[];
  readonly headline: ScoreCount;
}

export class FullContextControlError extends Error {
  readonly name = "FullContextControlError";
}

const WHITESPACE_PATTERN = /\s+/g;
const TRAILING_DOTS_PATTERN = /\.+$/;

const normalize = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(WHITESPACE_PATTERN, " ")
    .replace(TRAILING_DOTS_PATTERN, "");

const scoreArm = (
  arm: ScoreArm,
  questions: readonly FixtureQuestion[],
  answers: ReadonlyMap<FixtureQuestion, string>,
  disagreements: ScoreDisagreement[]
): ArmScore => {
  const categories = new Map<FixtureQuestion["category"], ScoreCount>();
  let correct = 0;

  for (const fixtureQuestion of questions) {
    const actual = normalize(answers.get(fixtureQuestion) ?? "");
    const expected = normalize(fixtureQuestion.answer);
    const previous = categories.get(fixtureQuestion.category) ?? {
      correct: 0,
      total: 0,
    };
    const matches = actual === expected;

    categories.set(fixtureQuestion.category, {
      correct: previous.correct + (matches ? 1 : 0),
      total: previous.total + 1,
    });
    correct += matches ? 1 : 0;

    if (!matches) {
      disagreements.push({
        actual,
        arm,
        category: fixtureQuestion.category,
        expected,
        question: fixtureQuestion.question,
      });
    }
  }

  return {
    overall: { correct, total: questions.length },
    perCategory: [...categories.entries()].map(([category, score]) => ({
      category,
      ...score,
    })),
  };
};

export function scoreAnswers(
  questions: readonly FixtureQuestion[],
  fullAnswers: ReadonlyMap<FixtureQuestion, string>,
  compactedAnswers: ReadonlyMap<FixtureQuestion, string>
): CompactionScore {
  const disagreements: ScoreDisagreement[] = [];
  const full = scoreArm("full", questions, fullAnswers, disagreements);
  const compacted = scoreArm(
    "compacted",
    questions,
    compactedAnswers,
    disagreements
  );

  if (full.overall.correct !== full.overall.total) {
    throw new FullContextControlError(
      `Invalid compaction score: full-context control scored ${full.overall.correct}/${full.overall.total}.`
    );
  }

  return {
    arms: { compacted, full },
    disagreements,
    headline: compacted.overall,
  };
}
