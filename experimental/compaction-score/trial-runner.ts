import { estimateModelMessagesTokens } from "@minpeter/pss-runtime";
import type { LanguageModel, ModelMessage } from "ai";
import { DEFAULT_PROVIDER_TIMEOUT_MS } from "./benchmark-options";
import type { CompactionFixture, FixtureQuestion } from "./fixture";
import { BatchedAnswerProtocolError, parseBatchedAnswers } from "./protocol";
import type { PromptProfileIdentity, TrialRecord } from "./report";
import {
  type CompactionScore,
  FullContextControlError,
  scoreAnswers,
} from "./scorer";
import { generateCompactionHops } from "./trial-compaction-hops";
import { evaluateArm, stableTrialError } from "./trial-provider-boundary";

type EvaluationArm = "compacted" | "full";

export interface TrialInput {
  readonly attempt: number;
  readonly enforceSummaryOutputBudget?: boolean;
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
  readonly summaryModel?: LanguageModel;
}

export async function runCompactionTrial(
  input: TrialInput
): Promise<TrialRecord> {
  const generated = await generateCompactionHops(input);
  switch (generated.status) {
    case "failure":
      return invalidRecord(input, generated.failureStatus, generated.cause);
    case "success":
      break;
    default:
      return assertNever(generated);
  }
  const { compactedContext, finalHop, fullContext, hops } = generated;
  const contexts: Record<EvaluationArm, ModelMessage[]> = {
    compacted: compactedContext,
    full: fullContext,
  };
  const armOrder: readonly EvaluationArm[] =
    input.repetition % 2 === 0 ? ["compacted", "full"] : ["full", "compacted"];
  const answers: Record<EvaluationArm, Map<FixtureQuestion, string>> = {
    compacted: new Map(),
    full: new Map(),
  };

  for (const arm of armOrder) {
    const evaluated = await evaluateArm({
      context: contexts[arm],
      model: input.model,
      questions: input.fixture.questions,
      ...(input.seed === undefined ? {} : { seed: input.seed }),
      signal: AbortSignal.timeout(
        input.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
      ),
    }).then(
      (output) => ({ output, status: "success" }) as const,
      (cause: unknown) => ({ cause, status: "failure" }) as const
    );
    switch (evaluated.status) {
      case "failure":
        return invalidRecord(
          input,
          "evaluation-provider-failure",
          evaluated.cause
        );
      case "success":
        break;
      default:
        return assertNever(evaluated);
    }
    try {
      answers[arm] = parseBatchedAnswers(
        evaluated.output,
        input.fixture.questions
      );
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
      answers.full,
      answers.compacted
    );
  } catch (cause) {
    if (cause instanceof FullContextControlError) {
      return invalidRecord(input, "invalid-full-control", cause);
    }
    throw cause;
  }
  return {
    answers: {
      compacted: input.fixture.questions.map(
        (question) => answers.compacted.get(question) ?? ""
      ),
      full: input.fixture.questions.map(
        (question) => answers.full.get(question) ?? ""
      ),
    },
    fixtureSeed: input.fixtureSeed,
    hops: hops.map((hop) => ({
      ...hop,
      sentOutputTokens: hop.sentOutputTokens ?? input.summaryMaxOutputTokens,
    })),
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

export function trialSummaryOutputTokenLimit(requested: number): number {
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TypeError(
      "Trial summary output limit must be a positive integer."
    );
  }
  return requested;
}

function assertNever(_value: never): never {
  throw new TypeError("Unexpected trial execution status.");
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
