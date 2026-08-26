import type {
  RuntimeBlockObservation,
  RuntimeBlockTrial,
} from "./runtime-block-time-metrics";

export interface PairedRuntimeBlockTrial extends RuntimeBlockTrial {
  readonly actualTurnDeltaMs: number;
  readonly completionDeltaMs: number;
  readonly controlRequestMs: number;
  readonly dispatchBlockMs: number;
  readonly pairOrder: "control-treatment" | "treatment-control";
  readonly pathValid: true;
  readonly targetRequestMs: number;
}

export interface PairedRuntimeBlockObservation extends RuntimeBlockObservation {
  readonly controlTurnEndedAtMs: number;
  readonly controlTurnStartedAtMs: number;
  readonly targetTurnEndedAtMs: number;
  readonly targetTurnStartedAtMs: number;
}

export function assertPairedObservation(
  value: RuntimeBlockObservation
): asserts value is PairedRuntimeBlockObservation {
  if (
    typeof value.controlTurnEndedAtMs !== "number" ||
    typeof value.controlTurnStartedAtMs !== "number" ||
    typeof value.targetTurnEndedAtMs !== "number" ||
    typeof value.targetTurnStartedAtMs !== "number"
  ) {
    throw new TypeError("Production overlap observation is not paired.");
  }
}

export function assertPairedTrial(
  value: RuntimeBlockTrial
): asserts value is PairedRuntimeBlockTrial {
  if (
    typeof value.actualTurnDeltaMs !== "number" ||
    typeof value.completionDeltaMs !== "number" ||
    typeof value.controlRequestMs !== "number" ||
    typeof value.dispatchBlockMs !== "number" ||
    value.pairOrder === undefined ||
    value.pathValid !== true ||
    typeof value.targetRequestMs !== "number"
  ) {
    throw new TypeError("Production overlap trial is not paired.");
  }
}
