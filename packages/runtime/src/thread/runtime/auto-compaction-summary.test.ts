import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import {
  buildCompactionSummaryInstructions,
  COMPACTION_SUMMARY_CONTRACT,
  summarizeCompactionRange,
} from "./auto-compaction-summary";

const SMALLER_CONTEXT_ERROR = /smaller than its source context/i;

describe("automatic compaction summary contract", () => {
  it("defines a continuation handoff with durable coding-state sections", () => {
    expect(COMPACTION_SUMMARY_CONTRACT.sections.map(({ id }) => id)).toEqual([
      "objective",
      "constraints",
      "progress",
      "decisions",
      "files",
      "tool-evidence",
      "open-work",
      "critical-values",
      "failed-approaches",
    ]);
    expect(COMPACTION_SUMMARY_CONTRACT.rules).toMatchObject({
      continueConversation: false,
      distinguishPlannedFromCompleted: true,
      extractIntentBeforeWriting: true,
      internalInstructionIsNotUserIntent: true,
      mergePreviousSummary: true,
      preserveActiveUserRequestVerbatim: true,
      preserveLabeledStateVerbatim: true,
      preserveLatestCorrections: true,
    });

    const instructions = buildCompactionSummaryInstructions();
    const headings = instructions
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings).toEqual(
      COMPACTION_SUMMARY_CONTRACT.sections.map(({ title }) => `## ${title}`)
    );
    expect(instructions).toContain("Describe tool activity semantically");
    expect(instructions).toContain("Never serialize tool invocation syntax");
  });

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

  it("ends assistant-ended history with an explicit summary request", async () => {
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

    expect(captured?.prompt.at(-1)).toMatchObject({
      content: [
        {
          text: "Create the compaction summary now.",
          type: "text",
        },
      ],
      role: "user",
    });
  });

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
