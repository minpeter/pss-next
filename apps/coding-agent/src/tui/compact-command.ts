import { normalizeTurnError } from "@minpeter/pss-runtime";
import type { TuiCommand, TuiCommandResult } from "./command";
import { createTuiErrorPresentation } from "./error-presentation";

export interface CompactCommandContext {
  /** Run runtime-owned compaction for the current durable thread. */
  compact(instructions?: string): Promise<boolean>;
}

/** Explicit context compaction, matching the interactive Pi `/compact` UX. */
export function createCompactCommand(
  context: CompactCommandContext
): TuiCommand {
  return {
    description: "Compact session context: /compact [custom instructions]",
    execute: async (input): Promise<TuiCommandResult> => {
      try {
        const instructions = input.args.join(" ").trim() || undefined;
        const compacted = await context.compact(instructions);
        return compacted
          ? { message: "Session context compacted.", success: true }
          : {
              message: "Nothing to compact in the current session.",
              success: true,
            };
      } catch (error) {
        const normalized = normalizeTurnError(error);
        const presentation = createTuiErrorPresentation(
          normalized.message ?? error,
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
