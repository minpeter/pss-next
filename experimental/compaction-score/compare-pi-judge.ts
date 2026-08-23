import { generateText, type LanguageModel } from "ai";
import { MAX_ATTEMPTS, PROVIDER_TIMEOUT_MS } from "./compare-pi-config";
import type { ArmResult } from "./compare-pi-types";

/**
 * Re-grades exact-match misses with a paraphrase-tolerant judge. An unavailable
 * judge never inflates the semantic score.
 */
export async function withSemanticScore(
  model: LanguageModel,
  result: ArmResult
): Promise<ArmResult> {
  if (result.status !== "valid" || !result.score) {
    return result;
  }
  const misses = result.score.disagreements.filter(
    (item) => item.arm === "compacted"
  );
  let recovered = 0;
  for (const miss of misses) {
    try {
      const { text } = await generateText({
        abortSignal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        maxOutputTokens: 8,
        messages: [
          {
            content: [
              "You are grading a short factual answer.",
              `Question: ${miss.question}`,
              `Reference answer: ${miss.expected}`,
              `Candidate answer: ${miss.actual}`,
              "Does the candidate answer convey the same specific fact as the reference answer? Ignore phrasing, casing, and grammatical differences, but require the same concrete values and identifiers.",
              "Reply with exactly yes or no.",
            ].join("\n"),
            role: "user",
          },
        ],
        model,
        temperature: 0,
      });
      if (text.trim().toLowerCase().startsWith("yes")) {
        recovered += 1;
      }
    } catch (cause) {
      if (!(cause instanceof Error)) {
        throw cause;
      }
    }
  }
  return {
    ...result,
    semanticCorrect: result.score.headline.correct + recovered,
  };
}

export async function runArmWithRetry(
  run: () => Promise<ArmResult>
): Promise<ArmResult> {
  let last: ArmResult = { error: "not-run", status: "invalid" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    last = await run();
    if (last.status === "valid") {
      return last;
    }
  }
  return last;
}
