import {
  type ComparisonDetailMetrics,
  type ComparisonHopMetric,
  summarizeComparisonDetails,
} from "./comparison-detail-metrics";

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
      const status = string(arm.status, `row.${method}.status`);
      if (status !== "valid") {
        const counts = failures[method];
        counts.set(status, (counts.get(status) ?? 0) + 1);
      } else if (arm.hops !== undefined) {
        hops[method].push(
          ...array(arm.hops, `row.${method}.hops`).map((hop, index) =>
            parseHop(hop, `row.${method}.hops[${index}]`)
          )
        );
      }
    }
  }
  const arms = {
    pi: parseArm(overall.pi, "aggregate.overall.pi"),
    pss: parseArm(overall.pss, "aggregate.overall.pss"),
  };
  return {
    arms,
    details: {
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
    },
    failures,
    model: string(root.model, "model"),
  };
}

function parseArm(value: unknown, path: string): ArmAggregate {
  const arm = record(value, path);
  return {
    compressionMean: nullableNumber(
      arm.compressionMean,
      `${path}.compressionMean`
    ),
    invalid: nonnegativeInteger(arm.invalid, `${path}.invalid`),
    retained: nonnegativeInteger(arm.retained, `${path}.retained`),
    semanticRetained: nonnegativeInteger(
      arm.semanticRetained,
      `${path}.semanticRetained`
    ),
    total: nonnegativeInteger(arm.total, `${path}.total`),
    valid: nonnegativeInteger(arm.valid, `${path}.valid`),
  };
}

function parseHop(value: unknown, path: string): ComparisonHopMetric {
  const hop = record(value, path);
  const compactionMs =
    hop.compactionMs === undefined
      ? undefined
      : nonnegativeNumber(hop.compactionMs, `${path}.compactionMs`);
  return {
    ...(compactionMs === undefined ? {} : { compactionMs }),
    prefixTokens: positiveInteger(hop.prefixTokens, `${path}.prefixTokens`),
    ...(hop.summarizerInputTokens === undefined
      ? {}
      : {
          summarizerInputTokens: nonnegativeInteger(
            hop.summarizerInputTokens,
            `${path}.summarizerInputTokens`
          ),
        }),
    summaryTokens: nonnegativeInteger(
      hop.summaryTokens,
      `${path}.summaryTokens`
    ),
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

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ComparisonArtifactError(`${path} must be a non-empty string.`);
  }
  return value;
}

function nullableNumber(value: unknown, path: string): number | null {
  if (value === null) {
    return null;
  }
  return finiteNumber(value, path);
}

function nonnegativeInteger(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  if (!(Number.isInteger(parsed) && parsed >= 0)) {
    throw new ComparisonArtifactError(
      `${path} must be a non-negative integer.`
    );
  }
  return parsed;
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  if (!(Number.isInteger(parsed) && parsed > 0)) {
    throw new ComparisonArtifactError(`${path} must be a positive integer.`);
  }
  return parsed;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ComparisonArtifactError(`${path} must be a finite number.`);
  }
  return value;
}

function nonnegativeNumber(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  if (parsed < 0) {
    throw new ComparisonArtifactError(`${path} must be non-negative.`);
  }
  return parsed;
}
