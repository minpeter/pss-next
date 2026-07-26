import { expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { summarizeCompactionRange } from "./auto-compaction-summary";

it("uses an explicitly supplied signal for summary generation", async () => {
  const signal = new AbortController().signal;
  let capturedSignal: AbortSignal | undefined;
  const model = createMockLanguageModelV4((options) => {
    capturedSignal = options.abortSignal;
    return Promise.resolve(mockLanguageModelV4Text("summary"));
  });

  await expect(
    summarizeCompactionRange({
      history: [
        { content: "project is orbit. ".repeat(20), role: "user" },
        { content: "all project facts noted", role: "assistant" },
      ],
      model: { model },
      signal,
    })
  ).resolves.toBe("summary");

  expect(capturedSignal).toBe(signal);
});
