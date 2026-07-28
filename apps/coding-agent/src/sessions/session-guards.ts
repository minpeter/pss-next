import { raceWithExtensionTimeout } from "../extensions/operation-timeout";
import type { SessionLifecycleReason } from "./session-manager";

/**
 * Session lifecycle for extensions (#258, phase 1).
 *
 * Host-published bus events (subscribe via `services.events.on`):
 * - `host:session-start`    `{ key, name?, reason }` — a session became
 *   active (`startup` | `new` | `resume` | `fork` | `clear`).
 * - `host:session-switch`   `{ fromKey, toKey, reason }` — the active
 *   thread handle was replaced.
 * - `host:session-shutdown` `{ key }` — the interactive session is ending.
 *
 * Cancelable decision points use registered session guards instead of bus
 * events so the decision model stays strict: a guard either explicitly
 * cancels, or the change proceeds. Guard failures and timeouts fail closed
 * (the change is cancelled) and are attributed to the owning extension.
 */
export interface SessionChangeEvent {
  readonly fromKey: string;
  readonly reason: SessionLifecycleReason;
  /** Absent for pre-fork decisions: the fork target does not exist yet. */
  readonly toKey?: string;
}

export type SessionGuardDecision =
  | undefined
  | { readonly cancel?: boolean; readonly reason?: string };

export interface CodingAgentSessionGuard {
  beforeFork?(
    event: SessionChangeEvent
  ): Promise<SessionGuardDecision> | SessionGuardDecision;
  beforeSwitch?(
    event: SessionChangeEvent
  ): Promise<SessionGuardDecision> | SessionGuardDecision;
}

export interface RegisteredSessionGuard {
  readonly extensionId: string;
  readonly guard: CodingAgentSessionGuard;
}

export type SessionChangeApproval =
  | { readonly approved: true }
  | {
      readonly approved: false;
      readonly extensionId: string;
      readonly reason: string;
    };

/**
 * Consult every registered guard for a pending switch/fork. The first
 * cancellation wins; guard errors and timeouts cancel as well (fail
 * closed), attributed to the owning extension.
 */
export async function approveSessionChange({
  event,
  guards,
  kind,
  signal,
  timeoutMs,
}: {
  readonly event: SessionChangeEvent;
  readonly guards: readonly RegisteredSessionGuard[];
  readonly kind: "fork" | "switch";
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<SessionChangeApproval> {
  for (const { extensionId, guard } of guards) {
    const handler = kind === "fork" ? guard.beforeFork : guard.beforeSwitch;
    if (handler === undefined) {
      continue;
    }
    let decision: SessionGuardDecision;
    try {
      decision = await raceWithExtensionTimeout(
        extensionId,
        "hook",
        Promise.resolve(handler({ ...event })),
        {
          ...(signal === undefined ? {} : { signal }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }
      );
    } catch (error) {
      return {
        approved: false,
        extensionId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const validated = validateDecision(decision);
    if (validated.valid) {
      if (validated.cancel) {
        return {
          approved: false,
          extensionId,
          reason: validated.reason ?? "cancelled by extension",
        };
      }
      continue;
    }
    // Malformed decisions fail closed, consistent with strict hooks.
    return {
      approved: false,
      extensionId,
      reason: `invalid session guard decision from extension "${extensionId}"`,
    };
  }
  return { approved: true };
}

function validateDecision(decision: unknown):
  | { readonly valid: false }
  | {
      readonly cancel: boolean;
      readonly reason?: string;
      readonly valid: true;
    } {
  if (decision === undefined) {
    return { cancel: false, valid: true };
  }
  // Anything other than undefined or a plain decision object (including an
  // explicit null) fails closed, consistent with strict hook decisions.
  if (
    decision === null ||
    typeof decision !== "object" ||
    Array.isArray(decision)
  ) {
    return { valid: false };
  }
  const record = decision as { cancel?: unknown; reason?: unknown };
  for (const key of Object.keys(record)) {
    if (key !== "cancel" && key !== "reason") {
      return { valid: false };
    }
  }
  if (record.cancel !== undefined && typeof record.cancel !== "boolean") {
    return { valid: false };
  }
  if (record.reason !== undefined && typeof record.reason !== "string") {
    return { valid: false };
  }
  return {
    cancel: record.cancel === true,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    valid: true,
  };
}
