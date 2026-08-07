import type { ModelMessage } from "ai";
import { expect, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import type { AgentOptions } from "../../agent/core/options";
import type { AgentCompactionPolicy } from "../runtime/auto-compaction-types";
import { speculativeCompaction } from "../runtime/speculative-compaction";

export type CompactionAgentOptions = ConstructorParameters<typeof Agent>[0] & {
  readonly compaction?: AgentOptions["compaction"];
};

export const agentWithCompaction = (options: CompactionAgentOptions): Agent =>
  new Agent(options);

export const tenTokensPerMessage = (
  messages: readonly ModelMessage[]
): number => messages.length * 10;

/** A deliberately immediate policy used to make integration tests deterministic. */
export const tokenCompactionPolicy = ({
  retain,
  trigger,
}: {
  readonly retain: number;
  readonly trigger: number;
}): AgentCompactionPolicy => {
  const maxInputTokens = 10_000;
  return speculativeCompaction({
    estimateTokens: tenTokensPerMessage,
    maxInputTokens,
    prepareRatio: (trigger / maxInputTokens) * 0.9,
    promoteRatio: trigger / maxInputTokens,
    retainRatio: retain / maxInputTokens,
  });
};

export const storedAssistantOutput = (text: string): ModelMessage => ({
  content: [{ providerOptions: undefined, text, type: "text" }],
  role: "assistant",
});

export const waitForModelCalls = async (
  calls: () => number,
  expected: number
): Promise<void> => {
  await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(expected), {
    interval: 5,
    timeout: 500,
  });
};

export const nextMacrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
