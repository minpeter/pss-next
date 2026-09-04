import { APICallError } from "ai";
import type {
  ModelAttempt,
  TurnErrorMetadataV1,
} from "../thread/protocol/events";
import {
  normalizeApiCallError,
  PROVIDER_METADATA_FAILED,
} from "../thread/runtime/turn-error-provider-metadata";
import { safeTelemetryIdentifier } from "./model-usage";

/** Provider call identity reported by the AI SDK for one attempt. */
export interface ModelAttemptOrigin {
  readonly modelId?: string;
  readonly provider?: string;
}

export interface ModelAttemptTracker {
  readonly attempts: number;
  /** Records one physical provider call start. */
  begin(origin?: ModelAttemptOrigin): ModelAttempt;
  /** Resolves the open attempt as failed, if one exists. */
  fail(error: unknown): ModelAttempt | undefined;
  /** Resolves the open attempt as succeeded, if one exists. */
  succeed(origin?: ModelAttemptOrigin): ModelAttempt | undefined;
}

/**
 * Tracks provider call attempts for one runtime model step.
 *
 * AI SDK language-model middleware wraps each physical provider call inside
 * the SDK's retry closure. Each wrapper invocation opens an attempt and closes
 * it immediately after that call settles, before any retry backoff begins.
 */
export function createModelAttemptTracker({
  attemptId,
  now = () => Date.now(),
}: {
  readonly attemptId: string;
  readonly now?: () => number;
}): ModelAttemptTracker {
  let attempts = 0;
  let open:
    | { readonly attempt: number; readonly startedAt: number }
    | undefined;

  const identity = (origin?: ModelAttemptOrigin) => {
    const modelId = safeTelemetryIdentifier(origin?.modelId);
    const provider = safeTelemetryIdentifier(origin?.provider);
    return {
      ...(modelId === undefined ? {} : { modelId }),
      ...(provider === undefined ? {} : { provider }),
    };
  };

  const closeOpen = ():
    | { attempt: number; durationMs?: number }
    | undefined => {
    if (!open) {
      return undefined;
    }
    const elapsed = now() - open.startedAt;
    const attempt = open.attempt;
    open = undefined;
    return {
      attempt,
      ...(Number.isFinite(elapsed) && elapsed >= 0
        ? { durationMs: Math.round(elapsed) }
        : {}),
    };
  };

  return {
    get attempts() {
      return attempts;
    },

    begin(origin) {
      attempts += 1;
      open = { attempt: attempts, startedAt: now() };
      return {
        attempt: attempts,
        attemptId,
        ...identity(origin),
        phase: "start",
        type: "model-attempt",
      };
    },

    fail(error) {
      const closed = closeOpen();
      if (!closed) {
        return;
      }
      const metadata = normalizeAttemptError(error);
      return {
        attempt: closed.attempt,
        attemptId,
        ...(closed.durationMs === undefined
          ? {}
          : { durationMs: closed.durationMs }),
        ...(metadata === undefined ? {} : { error: metadata }),
        outcome: "failed",
        phase: "end",
        type: "model-attempt",
      };
    },

    succeed(origin) {
      const closed = closeOpen();
      if (!closed) {
        return;
      }
      return {
        attempt: closed.attempt,
        attemptId,
        ...(closed.durationMs === undefined
          ? {}
          : { durationMs: closed.durationMs }),
        ...identity(origin),
        outcome: "succeeded",
        phase: "end",
        type: "model-attempt",
      };
    },
  };
}

/**
 * Classifies an attempt failure with the same hardened normalization the turn
 * error path uses, so attempt events and `turn-error` agree on the category.
 */
function normalizeAttemptError(
  error: unknown
): TurnErrorMetadataV1 | undefined {
  const apiCallError = firstApiCallError(error);
  if (!apiCallError) {
    return undefined;
  }
  const metadata = normalizeApiCallError(apiCallError);
  return metadata === PROVIDER_METADATA_FAILED ? undefined : metadata;
}

const MAX_ERROR_DEPTH = 8;

function firstApiCallError(error: unknown): APICallError | undefined {
  let node = error;
  for (let depth = 0; depth < MAX_ERROR_DEPTH; depth += 1) {
    if (APICallError.isInstance(node)) {
      return node;
    }
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    const nested = readErrors(node) ?? readCause(node);
    if (nested === undefined) {
      return undefined;
    }
    node = nested;
  }
  return undefined;
}

function readErrors(node: object): unknown {
  try {
    const errors: unknown = Reflect.get(node, "errors");
    return Array.isArray(errors) && errors.length > 0
      ? errors.at(-1)
      : undefined;
  } catch {
    return undefined;
  }
}

function readCause(node: object): unknown {
  try {
    return Reflect.get(node, "cause");
  } catch {
    return undefined;
  }
}
