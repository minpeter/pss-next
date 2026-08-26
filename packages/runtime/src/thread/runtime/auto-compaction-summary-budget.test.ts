import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { summarizeCompactionRange } from "./auto-compaction-summary";

const SMALLER_CONTEXT_ERROR = /smaller than its source context/i;

describe("automatic compaction summary contract", () => {
  it("clamps the summary output budget below the estimated source size", async () => {
    let captured: MockLanguageModelV4CallOptions | undefined;
    const model = createMockLanguageModelV4((options) => {
      captured = options;
      return Promise.resolve(mockLanguageModelV4Text("summary"));
    });

    await summarizeCompactionRange({
      history: [
        { content: "fact ".repeat(300), role: "user" },
        { content: "noted", role: "assistant" },
      ],
      model: { maxOutputTokens: 100_000, model },
    });

    const maxOutputTokens = captured?.maxOutputTokens;
    expect(maxOutputTokens).toBeGreaterThanOrEqual(128);
    expect(maxOutputTokens).toBeLessThan(1000);
  });

  it("reports the effective summary output budget", async () => {
    let captured: MockLanguageModelV4CallOptions | undefined;
    let reported: number | undefined;
    const model = createMockLanguageModelV4((options) => {
      captured = options;
      return Promise.resolve(mockLanguageModelV4Text("summary"));
    });

    await summarizeCompactionRange({
      history: [
        { content: "fact ".repeat(300), role: "user" },
        { content: "noted", role: "assistant" },
      ],
      model: { maxOutputTokens: 100_000, model },
      onOutputBudget: (maxOutputTokens) => {
        reported = maxOutputTokens;
      },
    });

    expect(reported).toBe(captured?.maxOutputTokens);
    expect(reported).toBeLessThan(1000);
  });

  it("rejects a summary that does not reduce the source context", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("x".repeat(4000)))
    );

    await expect(
      summarizeCompactionRange({
        history: [
          { content: "short source fact", role: "user" },
          { content: "noted", role: "assistant" },
        ],
        model: { model },
      })
    ).rejects.toThrow(SMALLER_CONTEXT_ERROR);
  });

  it("does not count generated summary instructions as source context", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("y".repeat(300)))
    );

    await expect(
      summarizeCompactionRange({
        history: [
          { content: "tiny source", role: "user" },
          { content: "noted", role: "assistant" },
        ],
        model: { model },
      })
    ).rejects.toThrow(SMALLER_CONTEXT_ERROR);
  });

  it("includes the model-facing compaction wrapper in summary size", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("compact fact"))
    );

    await expect(
      summarizeCompactionRange({
        history: [{ content: "z".repeat(80), role: "user" }],
        model: { model },
      })
    ).rejects.toThrow(SMALLER_CONTEXT_ERROR);
  });
});
