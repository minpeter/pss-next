import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { getEditMethod } from "../methods";
import { EDIT_TASKS } from "../tasks";
import { runMethodAttempt } from "./run-attempt";

const task = EDIT_TASKS.find((item) => item.id === "single-line-to-two");
if (task === undefined) {
  throw new Error("fixture task missing");
}

const emptyUsage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: undefined,
  },
  outputTokens: {
    reasoning: undefined,
    text: undefined,
    total: undefined,
  },
};

/**
 * Runtime prefers doStream when present. Force generate path like pss-runtime
 * test utils (`createMockLanguageModelV4`).
 */
const scriptedToolThenText = (toolName: string, input: unknown, text: string) => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          {
            input: JSON.stringify(input),
            toolCallId: "call-1",
            toolName,
            type: "tool-call",
          },
        ],
        finishReason: { raw: "tool-calls", unified: "tool-calls" },
        usage: emptyUsage,
        warnings: [],
      },
      {
        content: [{ type: "text", text }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: emptyUsage,
        warnings: [],
      },
    ],
  });
  Object.defineProperty(model, "doStream", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  return model;
};

describe("runMethodAttempt via createAgent", () => {
  it("scores a scripted edit against the filesystem", async () => {
    const method = getEditMethod("grok-json");
    const model = scriptedToolThenText(
      "edit_file",
      { edits: [{ op: "write", content: task.expected }] },
      "done"
    );
    const attempt = await runMethodAttempt({
      disableThinking: true,
      languageModel: model,
      maxSteps: 4,
      method,
      model: "scripted",
      provider: (() => model) as never,
      requestAttempts: 1,
      requestTimeoutMs: 15_000,
      run: 1,
      task,
    });
    expect(attempt.transportStatus).toBe("ok");
    expect(attempt.passed).toBe(true);
    expect(attempt.format).toBe("grok-json");
    expect(attempt.editCalls).toBeGreaterThanOrEqual(1);
  });
});
