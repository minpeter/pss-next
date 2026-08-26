import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import { createRuntimeBlockModelTrace } from "./runtime-block-time-instrumentation";

describe("runtime block-time instrumentation", () => {
  it("classifies summary calls by structure after instruction prose changes", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("DONE"))
    );
    let sequence = 0;
    const trace = createRuntimeBlockModelTrace(
      model,
      () => 0,
      () => {
        sequence += 1;
        return sequence;
      }
    );

    await generateText({
      messages: [{ content: "history", role: "user" }],
      model: trace.model,
      system: "Rewrite this history into a compact continuation record.",
    });
    await generateText({
      model: trace.model,
      prompt: "[INTERNAL COMPACTION INSTRUCTION - NOT CONVERSATION HISTORY]",
    });

    expect(trace.calls.map(({ kind }) => kind)).toEqual([
      "summary",
      "foreground",
    ]);
  });
});
