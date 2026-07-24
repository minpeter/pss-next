import {
  CompactionSummaryNotSmallerError,
  compactionContextForModel,
  estimateModelMessagesTokens,
  ModelMessageHistory,
  selectSummaryOutputTokenLimit,
  summarizeCompactionRange,
  summaryHistoryForRange,
  type ThreadContextMessage,
} from "@minpeter/pss-runtime";
import type { LanguageModel, ModelMessage } from "ai";
import { DEFAULT_PROVIDER_TIMEOUT_MS } from "./benchmark-options";
import type { CompactionFixture, FixtureQuestion } from "./fixture";
import { BatchedAnswerProtocolError, parseBatchedAnswers } from "./protocol";
import type {
  CompactionHopRecord,
  PromptProfileIdentity,
  TrialRecord,
} from "./report";
import {
  type CompactionScore,
  FullContextControlError,
  scoreAnswers,
} from "./scorer";
import { evaluateArm, stableTrialError } from "./trial-provider-boundary";

type EvaluationArm = "compacted" | "full";

export interface TrialInput {
  readonly attempt: number;
  readonly fixture: CompactionFixture;
  readonly fixtureSeed: string;
  readonly id: string;
  readonly model: LanguageModel;
  readonly profile?: PromptProfileIdentity;
  readonly providerTimeoutMs?: number;
  readonly repetition: number;
  readonly seed?: number;
  readonly summaryInstructions?: string;
  readonly summaryMaxOutputTokens: number;
}

export async function runCompactionTrial(
  input: TrialInput
): Promise<TrialRecord> {
  const history = new ModelMessageHistory(input.fixture.messages);
  const fullContext = history.modelSnapshot();
  const generated = await generateCompactionHops(input, history, fullContext);
  if ("status" in generated) {
    return generated;
  }
  const { finalHop, hops } = generated;

  const compactedContext = toModelMessages(history.modelContextSnapshot());
  const contexts: Record<EvaluationArm, ModelMessage[]> = {
    compacted: compactedContext,
    full: fullContext,
  };
  const armOrder: readonly EvaluationArm[] =
    input.repetition % 2 === 0 ? ["compacted", "full"] : ["full", "compacted"];
  const answers = new Map<EvaluationArm, Map<FixtureQuestion, string>>();

  for (const arm of armOrder) {
    let output: string;
    try {
      output = await evaluateArm({
        context: contexts[arm],
        model: input.model,
        questions: input.fixture.questions,
        ...(input.seed === undefined ? {} : { seed: input.seed }),
        signal: providerCallSignal(input),
      });
    } catch (cause) {
      return invalidRecord(input, "evaluation-provider-failure", cause);
    }

    try {
      answers.set(arm, parseBatchedAnswers(output, input.fixture.questions));
    } catch (cause) {
      const status =
        cause instanceof BatchedAnswerProtocolError
          ? "protocol-failure"
          : "evaluation-provider-failure";
      return invalidRecord(input, status, cause);
    }
  }

  let score: CompactionScore;
  try {
    score = scoreAnswers(
      input.fixture.questions,
      answers.get("full") as Map<FixtureQuestion, string>,
      answers.get("compacted") as Map<FixtureQuestion, string>
    );
  } catch (cause) {
    if (cause instanceof FullContextControlError) {
      return invalidRecord(input, "invalid-full-control", cause);
    }
    throw cause;
  }

  return {
    fixtureSeed: input.fixtureSeed,
    hops,
    id: input.id,
    prefixTokens: estimateModelMessagesTokens(
      fullContext.slice(
        0,
        input.fixture.compactionEnds.at(-1) ?? fullContext.length
      )
    ),
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    repetition: input.repetition,
    scenario: input.fixture.scenario,
    score,
    status: "valid",
    summaryTokens: finalHop.summaryTokens,
  };
}

async function generateCompactionHops(
  input: TrialInput,
  history: ModelMessageHistory,
  fullContext: ModelMessage[]
): Promise<
  | {
      readonly finalHop: CompactionHopRecord;
      readonly hops: readonly CompactionHopRecord[];
    }
  | TrialRecord
> {
  const hops: CompactionHopRecord[] = [];
  let summary = "";
  for (
    let hopIndex = 0;
    hopIndex < input.fixture.compactionEnds.length;
    hopIndex += 1
  ) {
    const endSeqExclusive = input.fixture.compactionEnds[hopIndex] ?? 0;
    const range = { endSeqExclusive, startSeq: 0 };
    const summaryHistory = summaryHistoryForRange({
      compactions: history.compactionSnapshot(),
      history: fullContext,
      range,
    });
    const summaryInputTokens = estimateModelMessagesTokens(
      toModelMessages(summaryHistory)
    );
    try {
      summary = await summarizeCompactionRange({
        history: summaryHistory,
        model: {
          maxOutputTokens: selectSummaryOutputTokenLimit({
            inputTokens: summaryInputTokens,
            retainTokens: input.summaryMaxOutputTokens * 2,
          }),
          model: input.model,
          ...(input.seed === undefined
            ? {}
            : { seed: (input.seed + hopIndex) % 4_294_967_296 }),
          temperature: 0,
        },
        signal: providerCallSignal(input),
        ...(input.summaryInstructions === undefined
          ? {}
          : { summaryInstructions: input.summaryInstructions }),
      });
    } catch (cause) {
      return invalidRecord(input, classifySummaryFailure(cause), cause);
    }
    if (summary.length === 0) {
      return invalidRecord(
        input,
        "protocol-failure",
        `Summary model returned empty text at hop ${hopIndex + 1}.`
      );
    }

    history.recordCompaction({
      endSeqExclusive: range.endSeqExclusive,
      schemaVersion: 1,
      startSeq: range.startSeq,
      summary: { content: summary, role: "system" },
    });
    hops.push({
      endSeqExclusive,
      prefixTokens: summaryInputTokens,
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
    return invalidRecord(
      input,
      "protocol-failure",
      "Fixture has no compaction hops."
    );
  }
  return { finalHop, hops };
}

function providerCallSignal(input: TrialInput): AbortSignal {
  return AbortSignal.timeout(
    input.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
  );
}

function invalidRecord(
  input: TrialInput,
  status: Exclude<TrialRecord["status"], "valid">,
  cause: unknown
): TrialRecord {
  return {
    error: stableTrialError(status, cause),
    fixtureSeed: input.fixtureSeed,
    id: input.id,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    repetition: input.repetition,
    scenario: input.fixture.scenario,
    status,
  };
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
