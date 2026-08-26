import {
  compactionContextForModel,
  estimateModelMessagesTokens,
  ModelMessageHistory,
} from "@minpeter/pss-runtime";
import type { LanguageModel, ModelMessage } from "ai";
import {
  COMPARISON_SUMMARY_OUTPUT_BUDGET,
  PROVIDER_TIMEOUT_MS,
} from "./compare-pi-config";
import {
  assemblePiSummary,
  collectFileOperations,
} from "./compare-pi-conversation";
import { generatePiSummary } from "./compare-pi-summary-provider";
import type { ArmResult } from "./compare-pi-types";
import type { CompactionFixture, FixtureQuestion } from "./fixture";
import { parseBatchedAnswers } from "./protocol";
import { FullContextControlError, scoreAnswers } from "./scorer";
import { stableTrialError } from "./trial-provider-boundary";
import { runCompactionTrial } from "./trial-runner";

export async function runPssArm({
  fixture,
  fixtureSeed,
  model,
  repetition,
  summaryMaxOutputTokens = COMPARISON_SUMMARY_OUTPUT_BUDGET.maxOutputTokens,
}: {
  readonly fixture: CompactionFixture;
  readonly fixtureSeed: string;
  readonly model: LanguageModel;
  readonly repetition: number;
  readonly summaryMaxOutputTokens?: number;
}): Promise<ArmResult> {
  const record = await runCompactionTrial({
    attempt: 1,
    enforceSummaryOutputBudget: true,
    fixture,
    fixtureSeed,
    id: `pss-${fixture.scenario}-r${repetition}`,
    model,
    providerTimeoutMs: PROVIDER_TIMEOUT_MS,
    repetition,
    summaryMaxOutputTokens,
  });
  if (record.status !== "valid") {
    return { error: record.error, status: record.status };
  }
  return {
    ...(record.answers === undefined ? {} : { answers: record.answers }),
    hops: record.hops.map((hop) => ({
      ...(hop.compactionMs === undefined
        ? {}
        : { compactionMs: hop.compactionMs }),
      prefixTokens: hop.prefixTokens,
      sentOutputTokens: hop.sentOutputTokens,
      ...(hop.summarizerInputTokens === undefined
        ? {}
        : { summarizerInputTokens: hop.summarizerInputTokens }),
      summaryTokens: hop.summaryTokens,
    })),
    score: record.score,
    status: "valid",
  };
}

export async function runPiArm(
  fixture: CompactionFixture,
  repetition: number,
  model: LanguageModel,
  summaryMaxOutputTokens: number = COMPARISON_SUMMARY_OUTPUT_BUDGET.maxOutputTokens
): Promise<ArmResult> {
  const history = new ModelMessageHistory(fixture.messages);
  const fullContext = history.modelSnapshot();
  const hops: {
    compactionMs: number;
    prefixTokens: number;
    sentOutputTokens: number;
    summarizerInputTokens: number;
    summaryTokens: number;
  }[] = [];
  const fileOperations = { edited: new Set<string>(), read: new Set<string>() };
  let previousSummary: string | undefined;
  let previousEnd = 0;

  for (const endSeqExclusive of fixture.compactionEnds) {
    const compactionStartedAt = performance.now();
    const newMessages = fullContext.slice(previousEnd, endSeqExclusive);
    collectFileOperations(newMessages, fileOperations);
    let generated: {
      readonly summarizerInputTokens: number;
      readonly summary: string;
    };
    try {
      generated = await generatePiSummary({
        model,
        newMessages,
        previousSummary,
        summaryMaxOutputTokens,
      });
    } catch (cause) {
      const providerCause =
        cause instanceof Error ? cause : new Error("unknown provider failure");
      return {
        error: stableTrialError("summary-provider-failure", providerCause),
        status: "summary-provider-failure",
      };
    }
    if (generated.summary.length === 0) {
      return {
        error: stableTrialError("protocol-failure", "empty pi summary"),
        status: "protocol-failure",
      };
    }
    const summary = assemblePiSummary(generated.summary, fileOperations, {
      endSeqExclusive,
      maxOutputTokens: summaryMaxOutputTokens,
    });
    history.recordCompaction({
      endSeqExclusive,
      schemaVersion: 1,
      startSeq: 0,
      summary: { content: summary, role: "system" },
    });
    hops.push({
      compactionMs: performance.now() - compactionStartedAt,
      prefixTokens: estimateModelMessagesTokens(
        fullContext.slice(0, endSeqExclusive)
      ),
      sentOutputTokens: summaryMaxOutputTokens,
      summarizerInputTokens: generated.summarizerInputTokens,
      summaryTokens: estimateModelMessagesTokens([
        compactionContextForModel({
          endSeqExclusive,
          role: "compaction",
          startSeq: 0,
          summary,
        }),
      ]),
    });
    previousSummary = summary;
    previousEnd = endSeqExclusive;
  }

  const compactedContext = history
    .modelContextSnapshot()
    .map((message) =>
      message.role === "compaction"
        ? compactionContextForModel(message)
        : message
    );
  return evaluateBothArms({
    compactedContext,
    fullContext,
    hops,
    model,
    questions: fixture.questions,
    repetition,
  });
}

async function evaluateBothArms({
  compactedContext,
  fullContext,
  hops,
  model,
  questions,
  repetition,
}: {
  readonly compactedContext: ModelMessage[];
  readonly fullContext: ModelMessage[];
  readonly hops: NonNullable<ArmResult["hops"]>;
  readonly model: LanguageModel;
  readonly questions: readonly FixtureQuestion[];
  readonly repetition: number;
}): Promise<ArmResult> {
  const { evaluateArm } = await import("./trial-provider-boundary");
  const evaluateContext = (context: ModelMessage[]) =>
    evaluateArm({
      context,
      model,
      questions,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    }).then((output) => parseBatchedAnswers(output, questions));
  let compactedAnswers: Map<FixtureQuestion, string>;
  let fullAnswers: Map<FixtureQuestion, string>;
  try {
    if (repetition % 2 === 0) {
      compactedAnswers = await evaluateContext(compactedContext);
      fullAnswers = await evaluateContext(fullContext);
    } else {
      fullAnswers = await evaluateContext(fullContext);
      compactedAnswers = await evaluateContext(compactedContext);
    }
  } catch (cause) {
    const providerCause =
      cause instanceof Error ? cause : new Error("unknown provider failure");
    return {
      error: stableTrialError("evaluation-provider-failure", providerCause),
      status: "evaluation-provider-failure",
    };
  }
  try {
    return {
      answers: {
        compacted: questions.map(
          (question) => compactedAnswers.get(question) ?? ""
        ),
        full: questions.map((question) => fullAnswers.get(question) ?? ""),
      },
      hops,
      score: scoreAnswers(questions, fullAnswers, compactedAnswers),
      status: "valid",
    };
  } catch (cause) {
    if (!(cause instanceof FullContextControlError)) {
      throw cause;
    }
    return {
      error: stableTrialError("invalid-full-control", cause),
      status: "invalid-full-control",
    };
  }
}
