import type { ProductionTurnTimestamps } from "./production-overlap-types";

export function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array.`);
  }
  return value;
}

export function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a nonempty string.`);
  }
  return value;
}

export function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be finite.`);
  }
  return value;
}

export function positiveInteger(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${path} must be a positive safe integer.`);
  }
  return parsed;
}

export function productionOverlapTimestamps(
  raw: unknown,
  path: string
): ProductionTurnTimestamps {
  const value = object(raw, path);
  const result = {
    firstVisibleAtMs: finite(value.firstVisibleAtMs, path),
    providerStartedAtMs: finite(value.providerStartedAtMs, path),
    sentAtMs: finite(value.sentAtMs, path),
    stepStartedAtMs: finite(value.stepStartedAtMs, path),
    turnEndedAtMs: finite(value.turnEndedAtMs, path),
    turnStartedAtMs: finite(value.turnStartedAtMs, path),
  };
  if (
    result.sentAtMs > result.turnStartedAtMs ||
    result.turnStartedAtMs > result.stepStartedAtMs ||
    result.stepStartedAtMs > result.providerStartedAtMs ||
    result.providerStartedAtMs > result.firstVisibleAtMs ||
    result.firstVisibleAtMs > result.turnEndedAtMs
  ) {
    throw new TypeError(`${path} timestamps are not monotonic.`);
  }
  return result;
}

export function productionOverlapScenario(
  value: unknown
):
  | "candidate-fit-late-hit"
  | "candidate-too-broad-fallback"
  | "overlap-nonblocking"
  | "prepared-hit"
  | "repeated-failure-overflow-recovery"
  | "summary-failure-retry-hit" {
  switch (value) {
    case "candidate-fit-late-hit":
    case "candidate-too-broad-fallback":
    case "overlap-nonblocking":
    case "prepared-hit":
    case "repeated-failure-overflow-recovery":
    case "summary-failure-retry-hit":
      return value;
    default:
      throw new TypeError("Production overlap scenario is invalid.");
  }
}
