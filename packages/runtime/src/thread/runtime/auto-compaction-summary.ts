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
  buildToolEvidenceLedger,
  withToolEvidenceLedger,
} from "./auto-compaction-tool-evidence";
import type {
  AutoCompactionRange,
  ThreadModelContextTransform,
} from "./auto-compaction-types";

export const COMPACTION_SUMMARY_CONTRACT = {
  rules: {
    continueConversation: false,
    distinguishPlannedFromCompleted: true,
    extractIntentBeforeWriting: true,
    internalInstructionIsNotUserIntent: true,
    mergePreviousSummary: true,
    preserveActiveUserRequestVerbatim: true,
    preserveLabeledStateVerbatim: true,
    preserveLatestCorrections: true,
  },
  sections: [
    {
      id: "objective",
      instruction:
        "State the user's current objective and observable completion condition.",
      title: "Objective",
    },
    {
      id: "constraints",
      instruction:
        "Preserve explicit instructions, constraints, preferences, and scope boundaries.",
      title: "Constraints",
    },
    {
      id: "progress",
      instruction:
        "Separate completed work from current work and include verification evidence.",
      title: "Progress",
    },
    {
      id: "decisions",
      instruction:
        "Record final decisions and corrections; latest corrections supersede provisional values.",
      title: "Decisions and Corrections",
    },
    {
      id: "files",
      instruction:
        "List files read, created, modified, or deleted and each material change.",
      title: "Files and Code State",
    },
    {
      id: "tool-evidence",
      instruction:
        "Preserve exact commands, tool outcomes, errors, test counts, hashes, and external results.",
      title: "Tool Evidence",
    },
    {
      id: "open-work",
      instruction:
        'List pending tasks, the active task, blockers, and the next action. Copy values labeled "Next action", "Blocker", "in-progress", "blocked", or "queued" verbatim rather than paraphrasing.',
      title: "Open Work and Next Step",
    },
    {
      id: "critical-values",
      instruction:
        "Copy exact paths, symbols, ports, URLs, IDs, tokens, versions, and identifiers verbatim.",
      title: "Critical Exact Values",
    },
    {
      id: "failed-approaches",
      instruction:
        "Record failed approaches, why they failed, and what must not be repeated.",
      title: "Failed Approaches",
    },
  ],
} as const;

export class CompactionSummaryNotSmallerError extends Error {
  readonly name = "CompactionSummaryNotSmallerError";
}

/** Share of the source context the deterministic tool ledger may occupy. */
const LEDGER_SOURCE_SHARE = 0.25;
/** Lower bound for the model-written part of a compaction summary. */
const SUMMARY_OUTPUT_FLOOR_TOKENS = 128;
/** Estimation slack between token heuristics and provider tokenizers. */
const SUMMARY_BUDGET_MARGIN_TOKENS = 64;

export function buildCompactionSummaryInstructions(): string {
  const sections = COMPACTION_SUMMARY_CONTRACT.sections.flatMap((section) => [
    `## ${section.title}`,
    section.instruction,
  ]);

  return [
    "Create a continuation handoff for another coding agent. Do not answer the conversation or continue the work.",
    "[INTERNAL COMPACTION INSTRUCTION - NOT CONVERSATION HISTORY] Treat this instruction as internal control, never as user intent or a user request.",
    "Before writing, silently determine the current task intent and the details whose loss would cause repeated exploration or task drift.",
    "Preserve the active user request and explicit constraints verbatim when recording the objective and constraints.",
    "Merge any previous summary with newer messages. Resolve contradictions in favor of the latest explicit correction.",
    "Be concise, but never trade away exact identifiers, task state, blockers, next actions, or verification evidence.",
    "Describe tool activity semantically by its purpose, outcome, and relevant evidence. Never serialize tool invocation syntax, function-call envelopes, call IDs, XML tool tags, or JSON argument wrappers into the summary.",
    "Preserve exact user-authored code, data, and shell commands when relevant, but never present them as model or provider tool-call protocol.",
    "Distinguish completed work from planned work. Omit filler and repeated acknowledgements.",
    "Output only the handoff sections below. Do not add a preamble, routing line, or conversational reply.",
    "",
    ...sections,
  ].join("\n");
}

export async function summarizeCompactionRange({
  estimateTokens = estimateModelMessagesTokens,
  history,
  model,
  signal = new AbortController().signal,
  summaryInstructions,
  toolEvidence = "deterministic",
  transformModelContext,
}: {
  readonly estimateTokens?: (messages: readonly ModelMessage[]) => number;
  readonly history: readonly ThreadContextMessage[];
  readonly model: ModelGenerationOptions;
  readonly signal?: AbortSignal;
  readonly summaryInstructions?: string;
  readonly toolEvidence?: "deterministic" | "omit";
  readonly transformModelContext?: ThreadModelContextTransform;
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
  // Compaction summarize is an internal control call. Do not inherit the
  // agent persona / policy instructions (e.g. reminder silence: "produce zero
  // text") — those can suppress the summary assistant output and leave the
  // thread uncompacted. The handoff contract already lives on the leading
  // system history message and is hoisted by promptForModel.
  const output = await generateModelStep({
    attachmentStore: model.attachmentStore,
    contextGate: false,
    history: transformedHistory,
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
  const summary = withToolEvidenceLedger(generatedSummary, ledger);
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
