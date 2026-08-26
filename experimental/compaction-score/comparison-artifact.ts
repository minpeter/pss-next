import {
  type ComparisonDetailMetrics,
  type ComparisonHopMetric,
  summarizeComparisonDetails,
} from "./comparison-detail-metrics";
import type { InvalidTrialStatus } from "./report";
import { isBoundedTerminalText } from "./terminal-text";

export type ComparisonMethod = "pi" | "pss";

export interface ArmAggregate {
  readonly compressionMean: number | null;
  readonly invalid: number;
  readonly retained: number;
  readonly semanticRetained: number;
  readonly total: number;
  readonly valid: number;
}

export interface ComparisonArtifact {
  readonly arms: Readonly<Record<ComparisonMethod, ArmAggregate>>;
  readonly details: Readonly<
    Record<ComparisonMethod, ComparisonDetailMetrics | null>
  >;
  readonly failures: Readonly<
    Record<ComparisonMethod, ReadonlyMap<string, number>>
  >;
  readonly model: string;
}

const METHODS: readonly ComparisonMethod[] = ["pss", "pi"];
const MAX_LABEL_LENGTH = 256;
const TRIAL_STATUSES = {
  "compaction-prompt-failure": true,
  "evaluation-provider-failure": true,
  "invalid-full-control": true,
  "non-compressing-summary": true,
  "protocol-failure": true,
  "summary-provider-failure": true,
  valid: true,
} as const satisfies Readonly<Record<InvalidTrialStatus | "valid", true>>;

export class ComparisonArtifactError extends Error {
  readonly name = "ComparisonArtifactError";
}

export function parseComparisonArtifact(value: unknown): ComparisonArtifact {
  const root = record(value, "comparison artifact");
  const aggregate = record(root.aggregate, "aggregate");
  const overall = record(aggregate.overall, "aggregate.overall");
  const failures: Record<ComparisonMethod, Map<string, number>> = {
    pi: new Map(),
    pss: new Map(),
  };
  const hops: Record<ComparisonMethod, ComparisonHopMetric[]> = {
    pi: [],
    pss: [],
  };
  for (const rowValue of array(root.rows, "rows")) {
    const row = record(rowValue, "row");
    for (const method of METHODS) {
      const arm = record(row[method], `row.${method}`);
      const status = trialStatus(arm.status, `row.${method}.status`);
      if (status !== "valid") {
        const counts = failures[method];
        counts.set(status, (counts.get(status) ?? 0) + 1);
      } else if (arm.hops !== undefined) {
        for (const [index, hop] of array(
          arm.hops,
          `row.${method}.hops`
        ).entries()) {
          hops[method].push(parseHop(hop, `row.${method}.hops[${index}]`));
        }
      }
    }
  }
  const arms = {
    pi: parseArm(overall.pi, "aggregate.overall.pi"),
    pss: parseArm(overall.pss, "aggregate.overall.pss"),
  };
  let details: ComparisonArtifact["details"];
  try {
    details = {
      pi: summarizeComparisonDetails({
        hops: hops.pi,
        invalid: arms.pi.invalid,
        retained: arms.pi.retained,
        semanticRetained: arms.pi.semanticRetained,
        total: arms.pi.total,
        valid: arms.pi.valid,
      }),
      pss: summarizeComparisonDetails({
        hops: hops.pss,
        invalid: arms.pss.invalid,
        retained: arms.pss.retained,
        semanticRetained: arms.pss.semanticRetained,
        total: arms.pss.total,
        valid: arms.pss.valid,
      }),
    };
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ComparisonArtifactError(error.message);
    }
    throw error;
  }
  return {
    arms,
    details,
    failures,
    model: label(root.model, "model"),
  };
}

function parseArm(value: unknown, path: string): ArmAggregate {
  const arm = record(value, path);
  const invalid = nonnegativeInteger(arm.invalid, `${path}.invalid`);
  const retained = nonnegativeInteger(arm.retained, `${path}.retained`);
  const semanticRetained = nonnegativeInteger(
    arm.semanticRetained,
    `${path}.semanticRetained`
  );
  const total = nonnegativeInteger(arm.total, `${path}.total`);
  const valid = nonnegativeInteger(arm.valid, `${path}.valid`);
  if (
    retained > total ||
    semanticRetained < retained ||
    semanticRetained > total
  ) {
    throw new ComparisonArtifactError(
      `${path} retained counts must be ordered within total.`
    );
  }
  if (valid > Number.MAX_SAFE_INTEGER - invalid) {
    throw new ComparisonArtifactError(`${path} attempt count is too large.`);
  }
  return {
    compressionMean: nullableRatio(
      arm.compressionMean,
      `${path}.compressionMean`
    ),
    invalid,
    retained,
    semanticRetained,
    total,
    valid,
  };
}

function parseHop(value: unknown, path: string): ComparisonHopMetric {
  const hop = record(value, path);
  const prefixTokens = positiveInteger(
    hop.prefixTokens,
    `${path}.prefixTokens`
  );
  const summaryTokens = nonnegativeInteger(
    hop.summaryTokens,
    `${path}.summaryTokens`
  );
  if (summaryTokens > prefixTokens) {
    throw new ComparisonArtifactError(
      `${path}.summaryTokens must not exceed prefixTokens.`
    );
  }
  const compactionMs =
    hop.compactionMs === undefined
      ? undefined
      : boundedDuration(hop.compactionMs, `${path}.compactionMs`);
  return {
    ...(compactionMs === undefined ? {} : { compactionMs }),
    prefixTokens,
    ...(hop.summarizerInputTokens === undefined
      ? {}
      : {
          summarizerInputTokens: nonnegativeInteger(
            hop.summarizerInputTokens,
            `${path}.summarizerInputTokens`
          ),
        }),
    summaryTokens,
  };
}

function record(
  value: unknown,
  path: string
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new ComparisonArtifactError(`${path} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ComparisonArtifactError(`${path} must be an array.`);
  }
  return value;
}

function trialStatus(value: unknown, path: string): string {
  const status = label(value, path);
  if (!Object.hasOwn(TRIAL_STATUSES, status)) {
    throw new ComparisonArtifactError(`${path} must be a known trial status.`);
  }
  return status;
}

function label(value: unknown, path: string): string {
  const message = `${path} must be a non-empty terminal-safe string of at most ${MAX_LABEL_LENGTH} characters.`;
  if (!isBoundedTerminalText(value, MAX_LABEL_LENGTH)) {
    throw new ComparisonArtifactError(message);
  }
  return value;
}

function nullableRatio(value: unknown, path: string): number | null {
  if (value === null) {
    return null;
  }
  const parsed = finiteNumber(value, path);
  if (parsed < 0 || parsed > 1) {
    throw new ComparisonArtifactError(`${path} must be between zero and one.`);
  }
  return parsed;
}

function nonnegativeInteger(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  if (!(Number.isSafeInteger(parsed) && parsed >= 0)) {
    throw new ComparisonArtifactError(
      `${path} must be a non-negative safe integer.`
    );
  }
  return parsed;
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  if (!(Number.isSafeInteger(parsed) && parsed > 0)) {
    throw new ComparisonArtifactError(
      `${path} must be a positive safe integer.`
    );
  }
  return parsed;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ComparisonArtifactError(`${path} must be a finite number.`);
  }
  return value;
}

function boundedDuration(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  if (parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw new ComparisonArtifactError(
      `${path} must be between zero and ${Number.MAX_SAFE_INTEGER}.`
    );
  }
  return parsed;
}
