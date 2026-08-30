import type { TurnTransitionResult } from "./types";

export type TurnTransitionOperation =
  | "cancel"
  | "complete"
  | "durable-input"
  | "notification"
  | "start";

type TurnTransitionConflictReason = Extract<
  TurnTransitionResult,
  { readonly ok: false }
>["reason"];

export class TurnTransitionConflictError extends Error {
  readonly name = "TurnTransitionConflictError";
  readonly operation: TurnTransitionOperation;
  readonly reason: TurnTransitionConflictReason;
  readonly runId: string;

  constructor(
    runId: string,
    operation: TurnTransitionOperation,
    reason: TurnTransitionConflictReason
  ) {
    super(`Turn ${runId} could not ${operation}: ${reason}.`);
    this.operation = operation;
    this.reason = reason;
    this.runId = runId;
  }
}
