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
import { withToolEvidenceLedger } from "./auto-compaction-tool-evidence";
import type {
  AutoCompactionRange,
  ThreadModelContextTransform,
} from "./auto-compaction-types";

export const COMPACTION_SUMMARY_CONTRACT = {
  rules: {
    continueConversation: false,
    distinguishPlannedFromCompleted: true,
    mergePreviousSummary: true,
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

export function buildCompactionSummaryInstructions(): string {
  const sections = COMPACTION_SUMMARY_CONTRACT.sections.flatMap((section) => [
    `## ${section.title}`,
    section.instruction,
  ]);

  return [
    "Create a continuation handoff for another coding agent. Do not answer the conversation or continue the work.",
    "Merge any previous summary with newer messages. Resolve contradictions in favor of the latest explicit correction.",
    "Be concise, but never trade away exact identifiers, task state, blockers, next actions, or verification evidence.",
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
  transformModelContext,
}: {
  readonly estimateTokens?: (messages: readonly ModelMessage[]) => number;
  readonly history: readonly ThreadContextMessage[];
  readonly model: ModelGenerationOptions;
  readonly signal?: AbortSignal;
  readonly summaryInstructions?: string;
  readonly transformModelContext?: ThreadModelContextTransform;
}): Promise<string> {
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
  const transformedHistory = transformModelContext
    ? await transformModelContext(summaryHistory, signal)
    : summaryHistory;
  const output = await generateModelStep({
    attachmentStore: model.attachmentStore,
    contextGate: false,
    history: transformedHistory,
    instructions: model.instructions,
    maxOutputTokens: model.maxOutputTokens,
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
  const summary = withToolEvidenceLedger(generatedSummary, history);
  const sourceContext = history.map((message) =>
    message.role === "compaction" ? compactionContextForModel(message) : message
  );
  const sourceTokens = estimateTokens(sourceContext);
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
