import {
  buildCompactionSummaryInstructions,
  CompactionSummaryNotSmallerError,
  compactionContextForModel,
  estimateModelMessagesTokens,
  ModelMessageHistory,
  summarizeCompactionRange,
  summaryHistoryForRange,
  type ThreadContextMessage,
} from "@minpeter/pss-runtime";
import { type LanguageModel, type ModelMessage, wrapLanguageModel } from "ai";
import { DEFAULT_PROVIDER_TIMEOUT_MS } from "./benchmark-options";
import type { CompactionFixture } from "./fixture";
import type { CompactionHopRecord, TrialRecord } from "./report";

interface CompactionHopInput {
  readonly fixture: CompactionFixture;
  readonly model: LanguageModel;
  readonly providerTimeoutMs?: number;
  readonly seed?: number;
  readonly summaryInstructions?: string;
  readonly summaryMaxOutputTokens: number;
}

type CompactionGenerationResult =
  | {
      readonly cause: unknown;
      readonly failureStatus: Exclude<TrialRecord["status"], "valid">;
      readonly status: "failure";
    }
  | {
      readonly compactedContext: ModelMessage[];
      readonly finalHop: CompactionHopRecord;
      readonly fullContext: ModelMessage[];
      readonly hops: readonly CompactionHopRecord[];
      readonly status: "success";
    };

export async function generateCompactionHops(
  input: CompactionHopInput
): Promise<CompactionGenerationResult> {
  const history = new ModelMessageHistory(input.fixture.messages);
  const fullContext = history.modelSnapshot();
  const hops: CompactionHopRecord[] = [];
  let summary = "";
  for (
    let hopIndex = 0;
    hopIndex < input.fixture.compactionEnds.length;
    hopIndex += 1
  ) {
    const endSeqExclusive = input.fixture.compactionEnds[hopIndex] ?? 0;
    const compactionStartedAt = performance.now();
    const range = { endSeqExclusive, startSeq: 0 };
    const summaryHistory = summaryHistoryForRange({
      compactions: history.compactionSnapshot(),
      history: fullContext,
      range,
    });
    const modelSummaryHistory = toModelMessages(summaryHistory);
    const summaryInstructions =
      input.summaryInstructions ?? buildCompactionSummaryInstructions();
    const summarizerInputTokens = estimateModelMessagesTokens([
      { content: summaryInstructions, role: "system" },
      ...modelSummaryHistory,
      ...(modelSummaryHistory.at(-1)?.role === "assistant"
        ? [
            {
              content: "Create the compaction summary now.",
              role: "user" as const,
            },
          ]
        : []),
    ]);
    const summaryModel =
      typeof input.model === "string"
        ? input.model
        : wrapLanguageModel({
            middleware: {
              specificationVersion: "v4",
              transformParams: ({ params }) =>
                Promise.resolve({
                  ...params,
                  maxOutputTokens: input.summaryMaxOutputTokens,
                }),
            },
            model: input.model,
          });
    if (
      typeof input.model !== "string" &&
      input.model.doStream === undefined &&
      typeof summaryModel !== "string"
    ) {
      Object.defineProperty(summaryModel, "doStream", { value: undefined });
    }
    const summarized = await summarizeCompactionRange({
      history: summaryHistory,
      model: {
        maxOutputTokens: input.summaryMaxOutputTokens,
        model: summaryModel,
        ...(input.seed === undefined
          ? {}
          : { seed: (input.seed + hopIndex) % 4_294_967_296 }),
        temperature: 0,
      },
      signal: AbortSignal.timeout(
        input.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
      ),
      summaryInstructions,
      transformSummary: (assembledSummary) =>
        assembledSummary.slice(0, 4 * input.summaryMaxOutputTokens),
    }).then(
      (text) => ({ status: "success", text }) as const,
      (cause: unknown) => ({ cause, status: "failure" }) as const
    );
    switch (summarized.status) {
      case "failure":
        return {
          cause: summarized.cause,
          failureStatus: classifySummaryFailure(summarized.cause),
          status: "failure",
        };
      case "success":
        summary = summarized.text;
        break;
      default:
        return assertNever(summarized);
    }
    if (summary.length === 0) {
      return {
        cause: `Summary model returned empty text at hop ${hopIndex + 1}.`,
        failureStatus: "protocol-failure",
        status: "failure",
      };
    }

    history.recordCompaction({
      endSeqExclusive: range.endSeqExclusive,
      schemaVersion: 1,
      startSeq: range.startSeq,
      summary: { content: summary, role: "system" },
    });
    hops.push({
      compactionMs: performance.now() - compactionStartedAt,
      endSeqExclusive,
      prefixTokens: estimateModelMessagesTokens(
        fullContext.slice(0, endSeqExclusive)
      ),
      summarizerInputTokens,
      summaryTokens: estimateModelMessagesTokens([
        compactionContextForModel({
          endSeqExclusive,
          role: "compaction",
          startSeq: 0,
          summary,
        }),
      ]),
    });
  }
  const finalHop = hops.at(-1);
  if (!finalHop) {
    return {
      cause: "Fixture has no compaction hops.",
      failureStatus: "protocol-failure",
      status: "failure",
    };
  }
  return {
    compactedContext: toModelMessages(history.modelContextSnapshot()),
    finalHop,
    fullContext,
    hops,
    status: "success",
  };
}

function assertNever(_value: never): never {
  throw new TypeError("Unexpected compaction execution status.");
}

export function classifySummaryFailure(
  cause: unknown
): Exclude<TrialRecord["status"], "valid"> {
  return cause instanceof CompactionSummaryNotSmallerError
    ? "non-compressing-summary"
    : "summary-provider-failure";
}

function toModelMessages(
  context: readonly ThreadContextMessage[]
): ModelMessage[] {
  return context.map((message) =>
    message.role === "compaction" ? compactionContextForModel(message) : message
  );
}
