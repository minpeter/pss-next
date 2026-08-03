import { expect, it } from "vitest";
import { buildCompactionFixture } from "./fixture";
import { createMockLanguageModelV4 } from "./mock-language-model";
import { runCompactionTrial } from "./trial-runner";

it("stores a stable status instead of a raw provider error", async () => {
  const secret = "TRIAL_PROVIDER_SECRET_SENTINEL";
  const model = createMockLanguageModelV4(() =>
    Promise.reject(new Error(`raw provider body: ${secret}`))
  );

  const record = await runCompactionTrial({
    attempt: 1,
    fixture: buildCompactionFixture("trial-provider-redaction"),
    fixtureSeed: "trial-provider-redaction",
    id: "trial-provider-redaction",
    model,
    repetition: 1,
    seed: 42,
    summaryMaxOutputTokens: 768,
  });

  expect(record).toMatchObject({
    error: "summary-provider-failure",
    status: "summary-provider-failure",
  });
  expect(JSON.stringify(record)).not.toContain(secret);
});
