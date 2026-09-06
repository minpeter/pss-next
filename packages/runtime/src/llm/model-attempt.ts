import type { ModelAttempt } from "../thread/protocol/events";
import { normalizeTurnError } from "../thread/runtime/turn-error-metadata";
import { safeTelemetryIdentifier } from "./model-usage";

/** Provider call identity reported by the AI SDK for one attempt. */
export interface ModelAttemptOrigin {
  readonly modelId?: string;
  readonly provider?: string;
}

export interface ModelAttemptTracker {
  readonly attempts: number;
  /** Records one physical provider call start and closes any displaced call. */
  begin(origin?: ModelAttemptOrigin): readonly ModelAttempt[];
  /** Resolves the open attempt as failed, if one exists. */
  fail(error: unknown): ModelAttempt | undefined;
  /** Resolves the open attempt as succeeded, if one exists. */
  succeed(origin?: ModelAttemptOrigin): ModelAttempt | undefined;
}

/**
 * Tracks provider call attempts for one runtime model step.
 *
 * The runtime wraps each physical provider call inside its retry closure.
 * Each wrapper invocation opens an attempt and closes
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
    | {
        readonly attempt: number;
        readonly identity: ReturnType<typeof identity>;
        readonly startedAt: number;
      }
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
    | {
        attempt: number;
        durationMs?: number;
        identity: ReturnType<typeof identity>;
      }
    | undefined => {
    if (!open) {
      return;
    }
    const elapsed = now() - open.startedAt;
    const { attempt, identity: attemptIdentity } = open;
    open = undefined;
    return {
      attempt,
      ...(Number.isFinite(elapsed) && elapsed >= 0
        ? { durationMs: Math.round(elapsed) }
        : {}),
      identity: attemptIdentity,
    };
  };

  return {
    get attempts() {
      return attempts;
    },

    begin(origin) {
      const displaced = closeOpen();
      attempts += 1;
      const attemptIdentity = identity(origin);
      open = {
        attempt: attempts,
        identity: attemptIdentity,
        startedAt: now(),
      };
      return [
        ...(displaced
          ? [
              {
                attempt: displaced.attempt,
                attemptId,
                ...(displaced.durationMs === undefined
                  ? {}
                  : { durationMs: displaced.durationMs }),
                ...displaced.identity,
                outcome: "failed" as const,
                phase: "end" as const,
                type: "model-attempt" as const,
              },
            ]
          : []),
        {
          attempt: attempts,
          attemptId,
          ...attemptIdentity,
          phase: "start",
          type: "model-attempt",
        },
      ];
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
        ...closed.identity,
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
function normalizeAttemptError(error: unknown) {
  return normalizeTurnError(error).error;
}
