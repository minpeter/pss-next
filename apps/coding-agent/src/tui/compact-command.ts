import type { TuiCommand, TuiCommandResult } from "./command";

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
        return {
          message: `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
          success: false,
        };
      }
    },
    name: "compact",
  };
}
