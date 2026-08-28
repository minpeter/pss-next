export const FAULT_KINDS = [
  "latency",
  "timeout",
  "reset",
  "http_500",
  "throttle_429",
  "localstack_restart",
  "read_after_write",
  "conditional_412",
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

export type TypedFaultRule =
  | { readonly kind: "pass" }
  | {
      readonly count: number;
      readonly key: string;
      readonly kind: "http_500";
    }
  | {
      readonly count: number;
      readonly key: string;
      readonly kind: "throttle_429";
      readonly retryAfterSeconds: number;
    }
  | {
      readonly count: number;
      readonly key: string;
      readonly kind: "read_after_write";
    }
  | {
      readonly count: number;
      readonly key: string;
      readonly kind: "conditional_412";
    };

export interface FaultGeneration {
  readonly id: number;
  readonly installedAtMs: number;
  readonly rule: TypedFaultRule;
}

export interface ProxyRequest {
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  readonly key: string;
  readonly method: string;
}

export type ProxyDecision =
  | { readonly generation: number; readonly kind: "upstream" }
  | {
      readonly generation: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly kind: "synthetic";
      readonly status: 404 | 412 | 429 | 500 | 503;
    };

export interface ProxyOutcome {
  readonly error: string | null;
  readonly status: number | null;
}

export interface RequestDecisionEvent {
  readonly error: string | null;
  readonly generation: number;
  readonly key: string;
  readonly method: string;
  readonly status: number | null;
  readonly synthetic: boolean;
  readonly upstreamCalled: boolean;
}

export interface ScenarioResult {
  readonly convergence: boolean;
  readonly detail: string;
  readonly effect: "exactly_once" | "none";
  readonly injectionEvidence: boolean;
  readonly kind: FaultKind;
  readonly observed: boolean;
  readonly recovery: boolean;
}

export interface S3FaultReport {
  readonly ok: boolean;
  readonly scenarios: readonly ScenarioResult[];
}

export class BoundaryInputError extends Error {
  readonly name = "BoundaryInputError";
}

export function parseFaultRule(value: unknown): TypedFaultRule {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new BoundaryInputError("invalid fault rule");
  }
  switch (value.kind) {
    case "pass":
      return { kind: "pass" };
    case "http_500":
    case "read_after_write":
    case "conditional_412":
      return {
        count: positiveInteger(value.count),
        key: nonempty(value.key),
        kind: value.kind,
      };
    case "throttle_429":
      return {
        count: positiveInteger(value.count),
        key: nonempty(value.key),
        kind: "throttle_429",
        retryAfterSeconds: positiveInteger(value.retryAfterSeconds),
      };
    default:
      throw new BoundaryInputError("unknown fault rule kind");
  }
}

export function parseGeneration(value: unknown): FaultGeneration {
  if (!(isRecord(value) && isRecord(value.rule))) {
    throw new BoundaryInputError("invalid generation");
  }
  return Object.freeze({
    id: positiveInteger(value.id),
    installedAtMs: finiteNumber(value.installedAtMs),
    rule: Object.freeze(parseFaultRule(value.rule)),
  });
}

export function parseEvent(value: unknown): RequestDecisionEvent {
  if (!isRecord(value)) {
    throw new BoundaryInputError("invalid decision event");
  }
  const error = value.error;
  const status = value.status;
  if (
    (error !== null && typeof error !== "string") ||
    (status !== null && typeof status !== "number")
  ) {
    throw new BoundaryInputError("invalid decision outcome");
  }
  return Object.freeze({
    error,
    generation: positiveInteger(value.generation),
    key: nonempty(value.key),
    method: nonempty(value.method),
    status,
    synthetic: booleanValue(value.synthetic),
    upstreamCalled: booleanValue(value.upstreamCalled),
  });
}

export function requireLoopbackUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")
  ) {
    throw new BoundaryInputError(`${label} must be an HTTP loopback URL`);
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BoundaryInputError("expected non-empty string");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BoundaryInputError("expected positive integer");
  }
  return value;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BoundaryInputError("expected finite number");
  }
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new BoundaryInputError("expected boolean");
  }
  return value;
}
