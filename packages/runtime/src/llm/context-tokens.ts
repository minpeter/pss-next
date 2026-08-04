import type { ModelUsage } from "../thread/protocol/events";
import type {
  ModelPromptMeasurement,
  ModelPromptMeasurementProfile,
} from "./context-gate";

export type TokenEstimateBasis = "heuristic" | "calibrated" | "reported";

export interface TokenEstimate {
  readonly basis: TokenEstimateBasis;
  readonly marginTokens: number;
  readonly tokens: number;
}

export interface ContextUsageSnapshot {
  readonly calibration: {
    readonly observations: number;
    readonly revision: number;
    readonly scope?: string;
  };
  readonly contextWindow?: { readonly maxInputTokens: number };
  readonly currentRequest: {
    readonly input: TokenEstimate;
    readonly output: TokenEstimate;
    readonly total: TokenEstimate;
  };
}

/** Immutable, revision-pinned decomposition used by gates and compaction. */
export interface ContextTokenProfile {
  readonly fixedPrompt: number;
  readonly fullInput: number;
  readonly historyMarginal: readonly number[];
  readonly revision: number;
  readonly wrapper: number;
}

interface CalibrationBucket {
  fixed: Map<string, { errorBound: number; observations: number }>;
  inputObservations: number;
  marginalInputScale: number;
  outputObservations: number;
  outputTokens: number;
  outputUnits: number;
  previousByFixed: Map<
    string,
    {
      fixedFingerprint: string;
      inputTokens: number;
      messageUnits: number;
    }
  >;
  revision: number;
}

/** Process-local adaptive calibration shared by all threads of one Agent. */
export class ContextTokenCalibrationRegistry {
  readonly #buckets = new Map<string, CalibrationBucket>();
  readonly #attempts = new Set<string>();

  bucket(scope: string | undefined): CalibrationBucket | undefined {
    if (!scope) {
      return;
    }
    let bucket = this.#buckets.get(scope);
    if (!bucket) {
      bucket = {
        inputObservations: 0,
        marginalInputScale: 1,
        fixed: new Map(),
        outputTokens: 0,
        outputUnits: 0,
        outputObservations: 0,
        previousByFixed: new Map(),
        revision: 0,
      };
      this.#buckets.set(scope, bucket);
    }
    return bucket;
  }

  observe(
    attemptId: string,
    scope: string | undefined,
    fixedFingerprint: string,
    measurement: ModelPromptMeasurement,
    outputUnits: number,
    usage: ModelUsage
  ): boolean {
    if (!scope) {
      return false;
    }
    const observationId = `${scope}\0${attemptId}`;
    if (this.#attempts.has(observationId)) {
      return false;
    }
    this.#attempts.add(observationId);
    const bucket = this.bucket(scope);
    if (!bucket) {
      return false;
    }
    const reported = reportedUsageTokens(usage);
    const input = reported.input;
    if (input !== undefined) {
      const previous = bucket.previousByFixed.get(fixedFingerprint);
      // Only a same-fixed-prompt pair can safely identify marginal slope.
      if (previous?.fixedFingerprint === fixedFingerprint) {
        const deltaUnits =
          measurement.messageUnits.reduce((a, b) => a + b, 0) -
          previous.messageUnits;
        const deltaTokens = input - previous.inputTokens;
        if (deltaUnits > 0 && deltaTokens >= 0) {
          bucket.marginalInputScale = Math.max(
            bucket.marginalInputScale,
            deltaTokens / deltaUnits
          );
        }
      }
      const residual =
        input -
        measurement.messageUnits.reduce((a, b) => a + b, 0) *
          bucket.marginalInputScale -
        measurement.fixedUnits;
      const fixed = bucket.fixed.get(fixedFingerprint) ?? {
        errorBound: 0,
        observations: 0,
      };
      fixed.errorBound = Math.max(fixed.errorBound, residual, 0);
      fixed.observations += 1;
      bucket.fixed.set(fixedFingerprint, fixed);
      bucket.previousByFixed.set(fixedFingerprint, {
        fixedFingerprint,
        inputTokens: input,
        messageUnits: measurement.messageUnits.reduce((a, b) => a + b, 0),
      });
      bucket.inputObservations += 1;
    }
    if (reported.output !== undefined && outputUnits > 0) {
      bucket.outputUnits += outputUnits;
      bucket.outputTokens += reported.output;
      bucket.outputObservations += 1;
    }
    bucket.revision += 1;
    return true;
  }
}

export interface ContextTokenOptions {
  readonly calibration?: boolean;
  readonly measurementProfile?: ModelPromptMeasurementProfile;
}

interface Attempt {
  readonly attemptId: string;
  readonly fixedFingerprint: string;
  readonly measurement: ModelPromptMeasurement;
  outputUnits: number;
  usage?: ModelUsage;
}

export interface ContextTokenMeterCheckpoint {
  readonly attempt?: Attempt;
  readonly maxInputTokens?: number;
  readonly scope?: string;
}

export interface ContextTokenProfileInput {
  readonly contextMessageUnits?: readonly number[];
  readonly historyMessageUnits?: readonly number[];
  readonly wrapperUnits?: number;
}

export interface ContextTokenView {
  readonly estimateMessageUnits: (
    units: readonly number[]
  ) => readonly number[];
  readonly profile: (input?: ContextTokenProfileInput) => ContextTokenProfile;
}

export class ContextTokenMeter {
  readonly #registry: ContextTokenCalibrationRegistry;
  readonly #calibration: boolean;
  #attempt?: Attempt;
  #scope?: string;
  #maxInputTokens?: number;

  constructor(
    registry: ContextTokenCalibrationRegistry,
    options: ContextTokenOptions = {}
  ) {
    this.#registry = registry;
    this.#calibration = options.calibration !== false;
  }

  checkpoint(): ContextTokenMeterCheckpoint {
    return {
      ...(this.#attempt
        ? {
            attempt: {
              ...this.#attempt,
              outputUnits: this.#attempt.outputUnits,
            },
          }
        : {}),
      ...(this.#maxInputTokens === undefined
        ? {}
        : { maxInputTokens: this.#maxInputTokens }),
      ...(this.#scope === undefined ? {} : { scope: this.#scope }),
    };
  }

  restore(checkpoint: ContextTokenMeterCheckpoint): ContextUsageSnapshot {
    this.#attempt = checkpoint.attempt
      ? { ...checkpoint.attempt, outputUnits: checkpoint.attempt.outputUnits }
      : undefined;
    this.#maxInputTokens = checkpoint.maxInputTokens;
    this.#scope = checkpoint.scope;
    return this.snapshot();
  }

  begin(input: {
    attemptId: string;
    fixedFingerprint: string;
    maxInputTokens?: number;
    measurement: ModelPromptMeasurement;
    scope?: string;
  }): ContextUsageSnapshot {
    this.#attempt = { ...input, outputUnits: 0 };
    this.#scope = input.scope;
    this.#maxInputTokens = input.maxInputTokens;
    return this.snapshot();
  }

  outputDelta(
    attemptId: string,
    text: string
  ): ContextUsageSnapshot | undefined {
    if (this.#attempt?.attemptId !== attemptId) {
      return;
    }
    this.#attempt.outputUnits += text.length / 4;
    return this.snapshot();
  }

  report(
    attemptId: string,
    usage: ModelUsage,
    resolvedScope?: string
  ): ContextUsageSnapshot | undefined {
    const attempt = this.#attempt;
    if (attempt?.attemptId !== attemptId) {
      return;
    }
    attempt.usage = usage;
    if (this.#calibration) {
      this.#registry.observe(
        attemptId,
        this.#scope,
        attempt.fixedFingerprint,
        attempt.measurement,
        attempt.outputUnits,
        usage
      );
      if (resolvedScope && resolvedScope !== this.#scope) {
        this.#registry.observe(
          attemptId,
          resolvedScope,
          attempt.fixedFingerprint,
          attempt.measurement,
          attempt.outputUnits,
          usage
        );
      }
    }
    if (resolvedScope) {
      this.#scope = resolvedScope;
    }
    return this.snapshot();
  }

  abort(attemptId: string): ContextUsageSnapshot | undefined {
    if (this.#attempt?.attemptId !== attemptId) {
      return;
    }
    this.#attempt.outputUnits = 0;
    return this.snapshot();
  }

  snapshot(): ContextUsageSnapshot {
    const attempt = this.#attempt;
    const bucket = this.#calibration
      ? this.#registry.bucket(this.#scope)
      : undefined;
    const inputScale = bucket?.marginalInputScale ?? 1;
    const outputScale =
      bucket && bucket.outputUnits > 0
        ? bucket.outputTokens / bucket.outputUnits
        : 1;
    const messageUnits =
      attempt?.measurement.messageUnits.reduce((a, b) => a + b, 0) ?? 0;
    const fixed = attempt && bucket?.fixed.get(attempt.fixedFingerprint);
    const estimatedInput = Math.ceil(
      (attempt?.measurement.fixedUnits ?? 0) +
        messageUnits * inputScale +
        (fixed?.errorBound ?? 0)
    );
    const estimatedOutput = Math.ceil(
      (attempt?.outputUnits ?? 0) * outputScale
    );
    const reported = attempt?.usage
      ? reportedUsageTokens(attempt.usage)
      : undefined;
    const inputReported = reported?.input;
    const outputReported = reported?.output;
    const input = estimate(
      inputReported,
      estimatedInput,
      (bucket?.inputObservations ?? 0) > 0
    );
    const output = estimate(
      outputReported,
      estimatedOutput,
      (bucket?.outputObservations ?? 0) > 0
    );
    const totalReported = attempt?.usage?.totalTokens;
    const total: TokenEstimate =
      totalReported === undefined
        ? {
            basis: combinedBasis(input, output),
            marginTokens: input.marginTokens + output.marginTokens,
            tokens: input.tokens + output.tokens,
          }
        : ({
            basis: "reported",
            marginTokens: 0,
            tokens: totalReported,
          } as const);
    return {
      calibration: {
        observations: bucket?.inputObservations ?? 0,
        revision: bucket?.revision ?? 0,
        ...(this.#scope ? { scope: this.#scope } : {}),
      },
      ...(this.#maxInputTokens === undefined
        ? {}
        : { contextWindow: { maxInputTokens: this.#maxInputTokens } }),
      currentRequest: { input, output, total },
    };
  }

  inputUpperBound(): number {
    const estimate = this.snapshot().currentRequest.input;
    return estimate.tokens + estimate.marginTokens;
  }

  profile(input: ContextTokenProfileInput = {}): ContextTokenProfile {
    return this.view().profile(input);
  }

  view(): ContextTokenView {
    const attempt = this.#attempt;
    const bucket = this.#calibration
      ? this.#registry.bucket(this.#scope)
      : undefined;
    const scale = bucket?.marginalInputScale ?? 1;
    const fixedError =
      (attempt && bucket?.fixed.get(attempt.fixedFingerprint)?.errorBound) ?? 0;
    const fixedUnits = attempt?.measurement.fixedUnits ?? 0;
    const messageUnits = attempt?.measurement.messageUnits ?? [];
    const revision = bucket?.revision ?? 0;
    return Object.freeze({
      estimateMessageUnits: (units: readonly number[]) =>
        roundedUnitCosts(units, scale),
      profile: (input: ContextTokenProfileInput = {}) => {
        const fixedPrompt = Math.ceil(fixedUnits + fixedError);
        const contextMarginal = roundedUnitCosts(
          input.contextMessageUnits ?? messageUnits,
          scale
        );
        const historyMarginal = roundedUnitCosts(
          input.historyMessageUnits ?? messageUnits,
          scale
        );
        return Object.freeze({
          fixedPrompt,
          fullInput:
            fixedPrompt +
            contextMarginal.reduce((sum, tokens) => sum + tokens, 0),
          historyMarginal: Object.freeze(historyMarginal),
          revision,
          wrapper: Math.ceil((input.wrapperUnits ?? 0) * scale),
        });
      },
    });
  }

  estimateMessageUnits(units: readonly number[]): readonly number[] {
    return this.view().estimateMessageUnits(units);
  }
}

function reportedUsageTokens(usage: ModelUsage): {
  readonly input?: number;
  readonly output?: number;
} {
  let input = usage.inputTokens;
  let output = usage.outputTokens;
  if (
    input === undefined &&
    output !== undefined &&
    usage.totalTokens !== undefined &&
    usage.totalTokens >= output
  ) {
    input = usage.totalTokens - output;
  } else if (
    output === undefined &&
    input !== undefined &&
    usage.totalTokens !== undefined &&
    usage.totalTokens >= input
  ) {
    output = usage.totalTokens - input;
  }
  return { input, output };
}

function roundedUnitCosts(units: readonly number[], scale: number): number[] {
  let rounded = 0;
  let cumulative = 0;
  return units.map((value) => {
    cumulative += value * scale;
    const next = Math.ceil(cumulative);
    const cost = next - rounded;
    rounded = next;
    return cost;
  });
}

function combinedBasis(
  input: TokenEstimate,
  output: TokenEstimate
): TokenEstimateBasis {
  if (input.basis === "reported" && output.basis === "reported") {
    return "reported";
  }
  return input.basis === "heuristic" || output.basis === "heuristic"
    ? "heuristic"
    : "calibrated";
}

function estimate(
  reported: number | undefined,
  tokens: number,
  hasEvidence: boolean
): TokenEstimate {
  if (reported !== undefined) {
    return { basis: "reported", marginTokens: 0, tokens: reported };
  }
  return {
    basis: hasEvidence ? "calibrated" : "heuristic",
    marginTokens: Math.ceil(tokens * 0.2),
    tokens,
  };
}
