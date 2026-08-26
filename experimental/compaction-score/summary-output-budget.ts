import {
  compactionContextForModel,
  estimateModelMessagesTokens,
} from "@minpeter/pss-runtime";
import {
  type LanguageModel,
  type LanguageModelMiddleware,
  wrapLanguageModel,
} from "ai";

export interface EnforcedSummaryOutput {
  readonly estimatedTokens: number;
  readonly text: string;
  readonly truncated: boolean;
}

const ESTIMATED_CHARACTERS_PER_TOKEN = 4;

export function estimateSummaryOutputTokens(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARACTERS_PER_TOKEN);
}

export function enforceSummaryOutputBudget(
  text: string,
  maxOutputTokens: number
): EnforcedSummaryOutput {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new TypeError("Summary output budget must be a positive integer.");
  }
  const normalized = text.trim();
  const maximumCharacters = maxOutputTokens * ESTIMATED_CHARACTERS_PER_TOKEN;
  const truncated = normalized.length > maximumCharacters;
  const enforced = truncated
    ? normalized.slice(0, maximumCharacters)
    : normalized;
  return {
    estimatedTokens: estimateSummaryOutputTokens(enforced),
    text: enforced,
    truncated,
  };
}

export function createSummaryOutputBudgetModel(
  model: LanguageModel,
  maxOutputTokens: number
): LanguageModel {
  enforceSummaryOutputBudget("", maxOutputTokens);
  if (typeof model === "string") {
    throw new TypeError("Summary output enforcement requires a model object.");
  }
  const maximumCharacters = maxOutputTokens * ESTIMATED_CHARACTERS_PER_TOKEN;
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      let remainingCharacters = maximumCharacters;
      return {
        ...result,
        content: result.content.map((part) => {
          if (part.type !== "text") {
            return part;
          }
          const text = part.text.slice(0, remainingCharacters);
          remainingCharacters -= text.length;
          return { ...part, text };
        }),
      };
    },
  };
  return wrapLanguageModel({ middleware, model });
}

export function enforceCompactionSummaryOutputBudget(
  text: string,
  maxOutputTokens: number,
  endSeqExclusive: number
): EnforcedSummaryOutput {
  enforceSummaryOutputBudget("", maxOutputTokens);
  const normalized = text.trim();
  let low = 0;
  let high = Math.min(normalized.length, maxOutputTokens * 4);
  let result = "";
  let estimatedTokens = estimateCompactionTokens(result, endSeqExclusive);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = normalized.slice(0, middle);
    const candidateTokens = estimateCompactionTokens(
      candidate,
      endSeqExclusive
    );
    if (candidateTokens <= maxOutputTokens) {
      result = candidate;
      estimatedTokens = candidateTokens;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return {
    estimatedTokens,
    text: result,
    truncated: result.length < normalized.length,
  };
}

function estimateCompactionTokens(
  summary: string,
  endSeqExclusive: number
): number {
  return estimateModelMessagesTokens([
    compactionContextForModel({
      endSeqExclusive,
      role: "compaction",
      startSeq: 0,
      summary,
    }),
  ]);
}
