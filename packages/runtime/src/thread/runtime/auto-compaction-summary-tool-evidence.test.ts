import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { summarizeCompactionRange } from "./auto-compaction-summary";

describe("automatic compaction summary contract", () => {
  it("carries raw tool evidence forward when the model omits it", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("## Tool Evidence\nOmitted."))
    );

    await expect(
      summarizeCompactionRange({
        history: [
          { content: "context ".repeat(2000), role: "user" },
          {
            content: [
              {
                output: { type: "text", value: "5 passed, 4 failed" },
                toolCallId: "tool-1",
                toolName: "run_tests",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
        ],
        model: { model },
      })
    ).resolves.toContain("5 passed, 4 failed");
  });

  it("transforms the assembled summary before size validation", async () => {
    let assembledSummary = "";
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("x".repeat(4000)))
    );

    const summary = await summarizeCompactionRange({
      history: [
        { content: "context ".repeat(100), role: "user" },
        {
          content: [
            {
              output: { type: "text", value: "5 passed, 4 failed" },
              toolCallId: "tool-1",
              toolName: "run_tests",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
      model: { model },
      transformSummary: (assembled) => {
        assembledSummary = assembled;
        return assembled.slice(0, 128);
      },
    });

    expect(assembledSummary).toContain("5 passed, 4 failed");
    expect(summary).toHaveLength(128);
  });

  it("omits deterministic tool evidence when requested", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("Semantic outcome only."))
    );

    await expect(
      summarizeCompactionRange({
        history: [
          { content: "context ".repeat(2000), role: "user" },
          {
            content: [
              {
                output: {
                  type: "text",
                  value: '{"action":"get_weather","parameters":{}}',
                },
                toolCallId: "tool-1",
                toolName: "get_weather",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
        ],
        model: { model },
        toolEvidence: "omit",
      })
    ).resolves.toBe("Semantic outcome only.");
  });

  it("carries a prior deterministic tool ledger across another hop", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("## Progress\nStill working."))
    );

    await expect(
      summarizeCompactionRange({
        history: [
          {
            endSeqExclusive: 2,
            role: "compaction",
            startSeq: 0,
            summary: '## Deterministic Tool Evidence\n"5 passed, 4 failed"',
          },
          { content: "context ".repeat(2000), role: "user" },
        ],
        model: { model },
      })
    ).resolves.toContain("5 passed, 4 failed");
  });

  it("keeps one exact ledger entry when prose already repeats the tool output", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("5 passed, 4 failed"))
    );

    await expect(
      summarizeCompactionRange({
        history: [
          { content: "context ".repeat(2000), role: "user" },
          {
            content: [
              {
                output: { type: "text", value: "5 passed, 4 failed" },
                toolCallId: "tool-1",
                toolName: "run_tests",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
        ],
        model: { model },
      })
    ).resolves.toBe(
      '5 passed, 4 failed\n## Deterministic Tool Evidence\n"5 passed, 4 failed"'
    );
  });

  it("still compresses when tool output dominates the source context", async () => {
    const noisyValue = [
      "FINAL_ROOT_CAUSE=case-sensitive import mismatch",
      ...Array.from(
        { length: 200 },
        (_, index) =>
          `[debug:${index}] provisional=abcdef0123456789 status=ignored`
      ),
      "FINAL_ARTIFACT_SHA=194ea49130ed8f60",
    ].join("\n");
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("## Progress\nDiagnosed."))
    );

    const summary = await summarizeCompactionRange({
      history: [
        { content: "inspect the log", role: "user" },
        {
          content: [
            {
              output: { type: "text", value: noisyValue },
              toolCallId: "tool-1",
              toolName: "inspect_log",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
        { content: "diagnosis recorded", role: "assistant" },
      ],
      model: { model },
    });

    expect(summary).toContain("FINAL_ARTIFACT_SHA=194ea49130ed8f60");
    expect(summary).toContain(
      "FINAL_ROOT_CAUSE=case-sensitive import mismatch"
    );
  });
});
