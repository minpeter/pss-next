import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { ThreadCompactionRecord } from "../state/snapshot";
import type { CompactionRangePolicy } from "./auto-compaction-range";
import { selectAutoCompactionRange } from "./auto-compaction-range";

const userMessage = (text: string): ModelMessage => ({
  content: text,
  role: "user",
});

const assistantMessage = (text: string): ModelMessage => ({
  content: text,
  role: "assistant",
});

const assistantToolCallMessage = (): ModelMessage => ({
  content: [
    {
      input: { query: "old" },
      toolCallId: "call-1",
      toolName: "lookup",
      type: "tool-call",
    },
  ],
  role: "assistant",
});

const toolResultMessage = (): ModelMessage => ({
  content: [
    {
      output: { type: "text", value: "result" },
      toolCallId: "call-1",
      toolName: "lookup",
      type: "tool-result",
    },
  ],
  role: "tool",
});

const compactionRecord = (
  endSeqExclusive: number,
  summary = "earlier summary"
): ThreadCompactionRecord => ({
  endSeqExclusive,
  schemaVersion: 1,
  startSeq: 0,
  summary: { content: summary, role: "system" },
});

const tenTokensPerMessage = (messages: readonly ModelMessage[]): number =>
  messages.length * 10;

const policy = (
  overrides: Partial<CompactionRangePolicy> = {}
): CompactionRangePolicy => ({
  estimateTokens: tenTokensPerMessage,
  retainTokens: 20,
  triggerTokens: 40,
  ...overrides,
});

describe("selectAutoCompactionRange", () => {
  it("returns undefined while estimated tokens are below the trigger", () => {
    const history = [userMessage("a"), assistantMessage("b"), userMessage("c")];

    expect(
      selectAutoCompactionRange({
        compactions: [],
        history,
        policy: policy(),
      })
    ).toBeUndefined();
  });

  it("compacts the oldest messages once tokens reach the trigger, retaining the newest tail", () => {
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantMessage("a3"),
      userMessage("u4"),
      assistantMessage("a5"),
    ];

    expect(
      selectAutoCompactionRange({
        compactions: [],
        history,
        policy: policy(),
      })
    ).toEqual({ endSeqExclusive: 4, startSeq: 0 });
  });

  it("snaps the boundary backwards so tool-call/tool-result adjacency is never split", () => {
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantToolCallMessage(),
      toolResultMessage(),
      userMessage("u5"),
      assistantMessage("a6"),
      userMessage("u7"),
      assistantMessage("a8"),
    ];

    expect(
      selectAutoCompactionRange({
        compactions: [],
        history,
        policy: policy({ retainTokens: 30 }),
      })
    ).toEqual({ endSeqExclusive: 2, startSeq: 0 });
  });

  it("counts the existing compaction summary toward the token trigger", () => {
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantMessage("a3"),
      userMessage("u4"),
      assistantMessage("a5"),
      userMessage("u6"),
      assistantMessage("a7"),
    ];

    expect(
      selectAutoCompactionRange({
        compactions: [compactionRecord(4)],
        history,
        policy: policy(),
      })
    ).toEqual({ endSeqExclusive: 6, startSeq: 0 });
  });

  it("uses the latest effective prefix when a newer compaction covers less history", () => {
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantMessage("a3"),
      userMessage("u4"),
      assistantMessage("a5"),
      userMessage("u6"),
      assistantMessage("a7"),
    ];

    expect(
      selectAutoCompactionRange({
        compactions: [
          compactionRecord(6, "older wider summary"),
          compactionRecord(2, "newer shorter summary"),
        ],
        history,
        policy: policy(),
      })
    ).toEqual({ endSeqExclusive: 6, startSeq: 0 });
  });

  it("counts the model-facing wrapper around a chained summary", () => {
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantMessage("a3"),
      userMessage("u4"),
    ];
    const contentLengthEstimator = (messages: readonly ModelMessage[]) =>
      messages.reduce(
        (total, message) =>
          total +
          (typeof message.content === "string" ? message.content.length : 0),
        0
      );

    expect(
      selectAutoCompactionRange({
        compactions: [compactionRecord(2, "tiny")],
        history,
        policy: policy({
          estimateTokens: contentLengthEstimator,
          retainTokens: 0,
          triggerTokens: 50,
        }),
      })
    ).toEqual({ endSeqExclusive: 4, startSeq: 0 });
  });

  it("skips ranges whose source is smaller than one compaction wrapper", () => {
    const contentLengthEstimator = (messages: readonly ModelMessage[]) =>
      messages.reduce(
        (total, message) =>
          total +
          (typeof message.content === "string" ? message.content.length : 0),
        0
      );
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("tail ".repeat(30)),
    ];

    expect(
      selectAutoCompactionRange({
        compactions: [],
        history,
        policy: policy({
          estimateTokens: contentLengthEstimator,
          retainTokens: 0,
          triggerTokens: 100,
        }),
      })
    ).toBeUndefined();
  });

  it("does not compact again when only the summary and a small tail remain", () => {
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantMessage("a3"),
      userMessage("u4"),
      assistantMessage("a5"),
      userMessage("u6"),
      assistantMessage("a7"),
    ];

    expect(
      selectAutoCompactionRange({
        compactions: [compactionRecord(6)],
        history,
        policy: policy(),
      })
    ).toBeUndefined();
  });

  it("returns undefined when the safe boundary collapses onto the covered prefix", () => {
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantMessage("a3"),
      userMessage("u4"),
      assistantMessage("a5"),
    ];

    expect(
      selectAutoCompactionRange({
        compactions: [compactionRecord(4)],
        history,
        policy: policy({ retainTokens: 10, triggerTokens: 30 }),
      })
    ).toBeUndefined();
  });

  it("counts static instruction tokens toward the trigger", () => {
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
    ];

    expect(
      selectAutoCompactionRange({
        compactions: [],
        history,
        instructionsTokens: 25,
        policy: policy(),
      })
    ).toEqual({ endSeqExclusive: 2, startSeq: 0 });
  });

  it("shrinks the retained tail by the instruction budget", () => {
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantMessage("a3"),
      userMessage("u4"),
      assistantMessage("a5"),
    ];
    const policyWithLargerTail = policy({ retainTokens: 30 });

    expect(
      selectAutoCompactionRange({
        compactions: [],
        history,
        policy: policyWithLargerTail,
      })
    ).toEqual({ endSeqExclusive: 2, startSeq: 0 });
    expect(
      selectAutoCompactionRange({
        compactions: [],
        history,
        instructionsTokens: 25,
        policy: policyWithLargerTail,
      })
    ).toEqual({ endSeqExclusive: 4, startSeq: 0 });
  });

  it("estimates tokens from serialized message size when no estimator is injected", () => {
    const sizedUser = (index: number): ModelMessage => ({
      content: "x".repeat(73),
      role: index % 2 === 0 ? "user" : "assistant",
    });
    const history = Array.from({ length: 10 }, (_, index) => sizedUser(index));

    expect(
      selectAutoCompactionRange({
        compactions: [],
        history,
        policy: {
          retainTokens: 104,
          triggerTokens: 200,
        },
      })
    ).toEqual({ endSeqExclusive: 6, startSeq: 0 });
  });
});
