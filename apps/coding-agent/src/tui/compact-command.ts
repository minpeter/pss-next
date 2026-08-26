import {
  type ManualThreadCompactionResult,
  normalizeTurnError,
} from "@minpeter/pss-runtime";
import type { TuiCommand, TuiCommandResult } from "./command";
import { createTuiErrorPresentation } from "./error-presentation";

const ACTIVE_TURN_COMPACTION_ERROR = "Cannot compact while a turn is active.";

const isActiveTurnCompactionError = (error: unknown): boolean => {
  try {
    return (
      error instanceof Error && error.message === ACTIVE_TURN_COMPACTION_ERROR
    );
  } catch {
    return false;
  }
};

export interface CompactCommandContext {
  /** Run runtime-owned compaction for the current durable thread. */
  compact(instructions?: string): Promise<ManualThreadCompactionResult>;
}

/** Explicit context compaction, matching the interactive Pi `/compact` UX. */
export function createCompactCommand(
  context: CompactCommandContext
): TuiCommand {
  return {
    allowDuringActiveTurn: true,
    description: "Compact session context: /compact [custom instructions]",
    execute: async (input): Promise<TuiCommandResult> => {
      try {
        const instructions = input.args.join(" ").trim() || undefined;
        const result = await context.compact(instructions);
        if (result.status === "compacted") {
          return { message: "Session context compacted.", success: true };
        }
        return result.status === "empty"
          ? {
              message: "Nothing to compact in the current session.",
              success: true,
            }
          : {
              message:
                "Compaction was skipped because a hook rejected it or the session changed.",
              success: false,
            };
      } catch (error) {
        // isActiveTurnCompactionError keeps its instanceof narrowing fail-closed.
        const normalized = normalizeTurnError(error);
        const presentation = createTuiErrorPresentation(
          isActiveTurnCompactionError(error)
            ? ACTIVE_TURN_COMPACTION_ERROR
            : (normalized.message ?? "The request failed."),
          normalized.error
        );
        return {
          message: [
            `Compaction failed: ${presentation.message}`,
            ...(presentation.hint === undefined ? [] : [presentation.hint]),
          ].join(" "),
          success: false,
        };
      }
    },
    name: "compact",
  };
}
