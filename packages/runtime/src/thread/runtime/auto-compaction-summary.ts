import type { ModelMessage } from "ai";
import { estimateModelMessagesTokens } from "../../llm/context-gate";
import { generateModelStep } from "../../llm/model-step";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import {
  compactionContextForModel,
  type ThreadContextMessage,
} from "../state/context";
import { ModelMessageHistory } from "../state/history";
import type { ThreadCompactionRecord } from "../state/snapshot";
import { messageContentText } from "./auto-compaction-message-text";
import {
  buildCompactionSummaryInstructions as buildInstructions,
  COMPACTION_SUMMARY_CONTRACT as summaryContract,
} from "./auto-compaction-summary-contract";
import {
  buildToolEvidenceLedger,
  withToolEvidenceLedger,
} from "./auto-compaction-tool-evidence";
import type {
  AutoCompactionRange,
  ThreadModelContextTransform,
} from "./auto-compaction-types";

export const COMPACTION_SUMMARY_CONTRACT = summaryContract;

export function buildCompactionSummaryInstructions(): string {
  return buildInstructions();
}

export class CompactionSummaryNotSmallerError extends Error {
  readonly name = "CompactionSummaryNotSmallerError";
}

/** Share of the source context the deterministic tool ledger may occupy. */
const LEDGER_SOURCE_SHARE = 0.25;
/** Lower bound for the model-written part of a compaction summary. */
const SUMMARY_OUTPUT_FLOOR_TOKENS = 128;
/** Estimation slack between token heuristics and provider tokenizers. */
const SUMMARY_BUDGET_MARGIN_TOKENS = 64;

export async function summarizeCompactionRange({
  estimateTokens = estimateModelMessagesTokens,
  history,
  model,
  onOutputBudget,
  signal = new AbortController().signal,
  summaryInstructions,
  toolEvidence = "deterministic",
  transformModelContext,
  transformSummary,
}: {
  readonly estimateTokens?: (messages: readonly ModelMessage[]) => number;
  readonly history: readonly ThreadContextMessage[];
  readonly model: ModelGenerationOptions;
  readonly onOutputBudget?: (maxOutputTokens: number) => void;
  readonly signal?: AbortSignal;
  readonly summaryInstructions?: string;
  readonly toolEvidence?: "deterministic" | "omit";
  readonly transformModelContext?: ThreadModelContextTransform;
  /** Applied after deterministic tool evidence and before size validation. */
  readonly transformSummary?: (summary: string) => string;
}): Promise<string> {
  const sourceContext = history.map((message) =>
    message.role === "compaction" ? compactionContextForModel(message) : message
  );
  const sourceTokens = estimateTokens(sourceContext);
  const measureTokens = (text: string) =>
    estimateTokens([{ content: text, role: "system" }]);
  const ledger =
    toolEvidence === "omit"
      ? ""
      : buildToolEvidenceLedger(history, {
          budgetTokens: Math.floor(sourceTokens * LEDGER_SOURCE_SHARE),
          measureTokens,
        });
  const maxOutputTokens = summaryOutputBudget({
    history,
    ledger,
    modelMaxOutputTokens: model.maxOutputTokens,
    estimateTokens,
    sourceTokens,
  });
  onOutputBudget?.(maxOutputTokens);
  const summaryHistory: readonly ThreadContextMessage[] = [
    {
      content:
        summaryInstructions === undefined
          ? buildCompactionSummaryInstructions()
          : summaryInstructions,
      role: "system",
    },
    ...history,
  ];
  const transformedHistoryBase = transformModelContext
    ? await transformModelContext(summaryHistory, signal)
    : summaryHistory;
  const transformedHistory =
    transformedHistoryBase.at(-1)?.role === "assistant"
      ? [
          ...transformedHistoryBase,
          {
            content: "Create the compaction summary now.",
            role: "user" as const,
          },
        ]
      : transformedHistoryBase;
  const output = await generateModelStep({
    attachmentStore: model.attachmentStore,
    contextGate: false,
    history: transformedHistory,
    instructions: model.instructions,
    maxOutputTokens,
    model: model.model,
    seed: model.seed,
    signal,
    temperature: model.temperature,
  });
  const generatedSummary = output
    .flatMap((message) =>
      message.role === "assistant" ? messageContentText(message.content) : []
    )
    .join("\n\n")
    .trim();
  const assembledSummary = withToolEvidenceLedger(generatedSummary, ledger);
  const summary =
    transformSummary === undefined
      ? assembledSummary
      : transformSummary(assembledSummary);
  const summaryTokens = estimateTokens([
    compactionContextForModel({
      endSeqExclusive: history.length,
      role: "compaction",
      startSeq: 0,
      summary,
    }),
  ]);
  if (summaryTokens >= sourceTokens) {
    throw new CompactionSummaryNotSmallerError(
      `Compaction summary must be smaller than its source context (${summaryTokens} >= ${sourceTokens} estimated tokens).`
    );
  }
  return summary;
}

/**
 * Bound the model-written summary so ledger + wrapper + summary text stays
 * structurally below the source context, keeping the non-expansion guard a
 * safety net instead of a routine failure on tool-heavy ranges.
 */
function summaryOutputBudget({
  estimateTokens,
  history,
  ledger,
  modelMaxOutputTokens,
  sourceTokens,
}: {
  readonly estimateTokens: (messages: readonly ModelMessage[]) => number;
  readonly history: readonly ThreadContextMessage[];
  readonly ledger: string;
  readonly modelMaxOutputTokens: number | undefined;
  readonly sourceTokens: number;
}): number {
  const wrapperTokens = estimateTokens([
    compactionContextForModel({
      endSeqExclusive: history.length,
      role: "compaction",
      startSeq: 0,
      summary: ledger,
    }),
  ]);
  const budget = Math.max(
    SUMMARY_OUTPUT_FLOOR_TOKENS,
    sourceTokens - wrapperTokens - SUMMARY_BUDGET_MARGIN_TOKENS
  );
  return modelMaxOutputTokens === undefined
    ? budget
    : Math.min(modelMaxOutputTokens, budget);
}

export function summaryHistoryForRange({
  compactions,
  history,
  range,
}: {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly history: readonly ModelMessage[];
  readonly range: AutoCompactionRange;
}): ThreadContextMessage[] {
  const prefixHistory = history.slice(range.startSeq, range.endSeqExclusive);
  if (range.startSeq !== 0) {
    return structuredClone(prefixHistory);
  }

  const prefixCompactions = compactions.filter(
    (record) => record.endSeqExclusive <= range.endSeqExclusive
  );
  return new ModelMessageHistory(
    prefixHistory,
    undefined,
    prefixCompactions
  ).modelContextSnapshot();
}
