import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { summarizeCompactionRange } from "./auto-compaction-summary";

describe("automatic compaction summary contract", () => {
  it("passes deterministic generation controls to the summary model", async () => {
    let captured: MockLanguageModelV4CallOptions | undefined;
    const model = createMockLanguageModelV4((options) => {
      captured = options;
      return Promise.resolve(mockLanguageModelV4Text("summary"));
    });

    await expect(
      summarizeCompactionRange({
        history: [
          { content: "project is orbit. ".repeat(200), role: "user" },
          { content: "all project facts noted", role: "assistant" },
        ],
        model: {
          maxOutputTokens: 512,
          model,
          seed: 42,
          temperature: 0,
        },
      })
    ).resolves.toBe("summary");

    expect(captured).toMatchObject({
      maxOutputTokens: 512,
      seed: 42,
      temperature: 0,
    });
  });

  it("ends assistant-ended history with a user-role text request", async () => {
    let captured: MockLanguageModelV4CallOptions | undefined;
    const model = createMockLanguageModelV4((options) => {
      captured = options;
      return Promise.resolve(mockLanguageModelV4Text("summary"));
    });

    await summarizeCompactionRange({
      history: [
        { content: "project context. ".repeat(200), role: "user" },
        { content: "assistant response. ".repeat(100), role: "assistant" },
      ],
      model: { model },
    });

    expect(captured?.prompt.map(({ role }) => role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(captured?.prompt.at(-1)).toMatchObject({
      content: [{ text: expect.any(String), type: "text" }],
      role: "user",
    });
  });
});
