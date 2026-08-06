import {
  type AgentOptions,
  summarizeCompactionRange,
  type ThreadCompactionInput,
} from "@minpeter/pss-runtime";
import type { ModelMessage } from "ai";
import type { TuiCommand, TuiCommandResult } from "./command";

export interface CompactCommandContext {
  /** Summarize and compact the current durable thread. */
  compact(): Promise<{ compactedMessages: number }>;
}

interface CompactCurrentThreadOptions {
  readonly commit: (input: ThreadCompactionInput) => Promise<void>;
  readonly history: readonly ModelMessage[];
  readonly instructions: string;
  readonly model: AgentOptions["model"];
  readonly summarize?: (options: {
    readonly history: readonly ModelMessage[];
    readonly model: {
      readonly instructions: string;
      readonly model: AgentOptions["model"];
    };
  }) => Promise<string>;
}

/** Generate a continuation handoff and atomically install it as context. */
export async function compactCurrentThread({
  commit,
  history,
  instructions,
  model,
  summarize = summarizeCompactionRange,
}: CompactCurrentThreadOptions): Promise<{ compactedMessages: number }> {
  if (history.length === 0) {
    throw new Error("the current session has no conversation history");
  }
  const summary = await summarize({
    history,
    model: { instructions, model },
  });
  await commit({
    endSeqExclusive: history.length,
    startSeq: 0,
    summary,
  });
  return { compactedMessages: history.length };
}

/** Explicit context compaction, matching the interactive Pi `/compact` UX. */
export function createCompactCommand(
  context: CompactCommandContext
): TuiCommand {
  return {
    description: "Compact the current session context",
    execute: async (): Promise<TuiCommandResult> => {
      try {
        const { compactedMessages } = await context.compact();
        return {
          message: `Compacted ${compactedMessages} conversation messages.`,
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
