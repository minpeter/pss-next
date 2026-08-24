import { generateText, type LanguageModel } from "ai";
import { MAX_ATTEMPTS, PROVIDER_TIMEOUT_MS } from "./compare-pi-config";
import type { ArmResult } from "./compare-pi-types";

/**
 * Re-grades exact-match misses with a paraphrase-tolerant judge. An unavailable
 * judge never inflates the semantic score.
 */
export async function withSemanticScore(
  model: LanguageModel,
  result: ArmResult,
  semanticDeadline: AbortSignal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
): Promise<ArmResult> {
  if (result.status !== "valid" || !result.score) {
    return result;
  }
  const misses = result.score.disagreements.filter(
    (item) => item.arm === "compacted"
  );
  const listener = new AbortController();
  const deadlineReached = new Promise<undefined>((resolve) => {
    if (semanticDeadline.aborted) {
      resolve(undefined);
      return;
    }
    semanticDeadline.addEventListener("abort", () => resolve(undefined), {
      once: true,
      signal: listener.signal,
    });
  });
  let recovered = 0;
  try {
    for (const miss of misses) {
      if (semanticDeadline.aborted) {
        break;
      }
      const generatedText = Promise.resolve()
        .then(() =>
          generateText({
            abortSignal: semanticDeadline,
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
          })
        )
        .then(
          (generated) => generated.text,
          (): undefined => undefined
        );
      const text = await Promise.race([generatedText, deadlineReached]);
      if (semanticDeadline.aborted) {
        break;
      }
      if (text?.trim().toLowerCase() === "yes") {
        recovered += 1;
      }
    }
  } finally {
    listener.abort();
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
