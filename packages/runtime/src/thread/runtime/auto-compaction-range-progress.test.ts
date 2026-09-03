import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { ThreadCompactionRecord } from "../state/snapshot";
import { selectAutoCompactionRange } from "./auto-compaction-range";

const userMessage = (text: string): ModelMessage => ({
  content: text,
  role: "user",
});

const assistantMessage = (text: string): ModelMessage => ({
  content: text,
  role: "assistant",
});

const assistantToolCallMessage = (toolCallId: string): ModelMessage => ({
  content: [
    {
      input: { query: "old" },
      toolCallId,
      toolName: "lookup",
      type: "tool-call",
    },
  ],
  role: "assistant",
});

const toolResultMessage = (toolCallId: string): ModelMessage => ({
  content: [
    {
      output: { type: "text", value: "result" },
      toolCallId,
      toolName: "lookup",
      type: "tool-result",
    },
  ],
  role: "tool",
});

const compactionRecord = (
  endSeqExclusive: number,
  summary = "old"
): ThreadCompactionRecord => ({
  endSeqExclusive,
  schemaVersion: 1,
  startSeq: 0,
  summary: { content: summary, role: "system" },
});

const tenTokensPerMessage = (messages: readonly ModelMessage[]): number =>
  messages.length * 10;

const historyWithToolExchange = (): readonly ModelMessage[] => [
  userMessage("u0"),
  assistantMessage("a1"),
  userMessage("u2"),
  assistantToolCallMessage("call-1"),
  toolResultMessage("call-1"),
  assistantMessage("a5"),
  userMessage("u6"),
  assistantMessage("a7"),
];

describe("selectAutoCompactionRange forward progress", () => {
  it("advances on a first compaction when backward selection collapses", () => {
    // Given: no covered prefix and a tool-heavy history with no safe boundary before the target.
    const history = [
      userMessage("u0"),
      assistantToolCallMessage("call-1"),
      toolResultMessage("call-1"),
      assistantToolCallMessage("call-2"),
      toolResultMessage("call-2"),
      assistantMessage("a5"),
      userMessage("u6"),
      assistantMessage("a7"),
    ];

    // When: the first compaction target lands inside the tool-heavy prefix.
    const range = selectAutoCompactionRange({
      compactions: [],
      history,
      policy: {
        estimateTokens: tenTokensPerMessage,
        retainTokens: 30,
        triggerTokens: 1,
      },
    });

    // Then: selection advances to the first safe boundary after the complete exchanges.
    expect(range).toEqual({ endSeqExclusive: 6, startSeq: 0 });
  });

  it("advances to the next safe boundary when backward selection collapses", () => {
    // Given: a covered prefix followed by a tool exchange around the target.
    const history = historyWithToolExchange();

    // When: selecting a range whose backward candidates are unsafe.
    const range = selectAutoCompactionRange({
      compactions: [compactionRecord(2)],
      history,
      policy: {
        estimateTokens: tenTokensPerMessage,
        retainTokens: 30,
        triggerTokens: 1,
      },
    });

    // Then: selection advances past the complete tool exchange.
    expect(range).toEqual({ endSeqExclusive: 6, startSeq: 0 });
  });

  it("keeps chained tool exchanges whole when advancing", () => {
    // Given: two chained exchanges followed by a terminal assistant response.
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantToolCallMessage("call-a"),
      toolResultMessage("call-a"),
      assistantToolCallMessage("call-b"),
      toolResultMessage("call-b"),
      assistantMessage("a7"),
      userMessage("u8"),
      assistantMessage("a9"),
    ];

    // When: the target lands inside the chained exchanges.
    const range = selectAutoCompactionRange({
      compactions: [compactionRecord(2)],
      history,
      policy: {
        estimateTokens: tenTokensPerMessage,
        retainTokens: 30,
        triggerTokens: 1,
      },
    });

    // Then: both exchanges are included through the terminal assistant.
    expect(range).toEqual({ endSeqExclusive: 8, startSeq: 0 });
  });

  it("prefers a safe backward boundary when one exists", () => {
    // Given: a safe boundary before a tool exchange.
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantToolCallMessage("call-1"),
      toolResultMessage("call-1"),
      userMessage("u5"),
      assistantMessage("a6"),
      userMessage("u7"),
      assistantMessage("a8"),
    ];

    // When: the target lands after that safe boundary.
    const range = selectAutoCompactionRange({
      compactions: [],
      history,
      policy: {
        estimateTokens: tenTokensPerMessage,
        retainTokens: 30,
        triggerTokens: 1,
      },
    });

    // Then: the existing backward preference is preserved.
    expect(range).toEqual({ endSeqExclusive: 2, startSeq: 0 });
  });

  it("does not recompact when the target equals the covered prefix", () => {
    // Given: only a covered summary and the requested tail remain.
    const history = historyWithToolExchange();

    // When: selection targets no messages beyond the covered prefix.
    const range = selectAutoCompactionRange({
      compactions: [compactionRecord(6)],
      history,
      policy: {
        estimateTokens: tenTokensPerMessage,
        retainTokens: 20,
        triggerTokens: 1,
      },
    });

    // Then: no redundant compaction is selected.
    expect(range).toBeUndefined();
  });

  it("returns undefined when no later terminal boundary exists", () => {
    // Given: history ending in a tool result without a terminal assistant.
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantToolCallMessage("call-1"),
      toolResultMessage("call-1"),
    ];

    // When: backward selection collapses inside the tool exchange.
    const range = selectAutoCompactionRange({
      compactions: [compactionRecord(2)],
      history,
      policy: {
        estimateTokens: tenTokensPerMessage,
        retainTokens: 10,
        triggerTokens: 1,
      },
    });

    // Then: validity wins over forced progress.
    expect(range).toBeUndefined();
  });

  it("accepts a safe boundary at the end of history", () => {
    // Given: a tool exchange ending in a terminal assistant at history end.
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantToolCallMessage("call-1"),
      toolResultMessage("call-1"),
      assistantMessage("a5"),
    ];

    // When: the first later safe boundary is history.length.
    const range = selectAutoCompactionRange({
      compactions: [compactionRecord(2)],
      history,
      policy: {
        estimateTokens: tenTokensPerMessage,
        retainTokens: 10,
        triggerTokens: 1,
      },
    });

    // Then: the inclusive scan accepts the end boundary.
    expect(range).toEqual({ endSeqExclusive: 6, startSeq: 0 });
  });

  it("keeps the compressibility floor after advancing", () => {
    // Given: a covered prefix and a tiny source whose next safe boundary follows a tool exchange.
    const history = [
      userMessage("u0"),
      assistantMessage("a1"),
      userMessage("u2"),
      assistantToolCallMessage("call-1"),
      toolResultMessage("call-1"),
      assistantMessage("a5"),
      userMessage("u6"),
      assistantMessage("a7"),
    ];
    const floorDecidingEstimator = (messages: readonly ModelMessage[]) =>
      messages.reduce(
        (total, message) =>
          total +
          (typeof message.content === "string" &&
          message.content.includes("<summary>\n\n</summary>")
            ? 10
            : 1),
        0
      );

    // When: backward selection collapses and forward selection finds boundary 6.
    const range = selectAutoCompactionRange({
      compactions: [compactionRecord(2, "old")],
      history,
      policy: {
        estimateTokens: floorDecidingEstimator,
        retainTokens: 3,
        triggerTokens: 1,
      },
    });

    // Then: the source remains rejected as smaller than its wrapper.
    expect(range).toBeUndefined();
  });
});
