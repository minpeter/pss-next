import { performance } from "node:perf_hooks";
import {
  BoundaryInputError,
  type FaultKind,
  type TypedFaultRule,
} from "./fault-proxy-types";
import type { FaultWorkerResult } from "./s3-fault-scenario";

export interface FaultWorkerContext {
  readonly objectPrefix: string;
  readonly workerUrl: URL;
}

export async function requestFaultWorker(
  context: FaultWorkerContext,
  kind: FaultKind
): Promise<FaultWorkerResult> {
  const objectName = `${context.objectPrefix}-${kind}`;
  const text = `fault-${kind}`;
  const startedAt = performance.now();
  try {
    const response = await fetch(
      new URL(`/?object=${encodeURIComponent(objectName)}`, context.workerUrl),
      {
        body: JSON.stringify({ idempotencyKey: objectName, text }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      }
    );
    const value: unknown = await response.json().catch(() => undefined);
    return {
      commitCount: numericField(value, "commitCount"),
      elapsedMs: performance.now() - startedAt,
      ok: response.ok,
      reply: stringField(value, "reply"),
      status: response.status,
    };
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof DOMException) {
      return {
        commitCount: null,
        elapsedMs: performance.now() - startedAt,
        ok: false,
        reply: null,
        status: null,
      };
    }
    throw error;
  }
}

export function faultRule(kind: FaultKind, key: string): TypedFaultRule {
  switch (kind) {
    case "latency":
    case "timeout":
    case "reset":
    case "localstack_restart":
      return { kind: "pass" };
    case "throttle_429":
      return { count: 1, key, kind, retryAfterSeconds: 2 };
    case "http_500":
    case "read_after_write":
    case "conditional_412":
      return { count: 1, key, kind };
    default:
      return assertNever(kind);
  }
}

function numericField(value: unknown, key: string): number | null {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : null;
}

function stringField(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new BoundaryInputError(`unhandled fault kind: ${value}`);
}
