import { TurnTransitionConflictError } from "../../execution/host/turn-transition-conflict";

export function isTurnTransitionConflictError(
  error: unknown
): error is TurnTransitionConflictError {
  try {
    return error instanceof TurnTransitionConflictError;
  } catch {
    return false;
  }
}
