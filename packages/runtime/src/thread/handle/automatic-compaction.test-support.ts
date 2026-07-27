import type { ModelMessage } from "ai";
import { expect, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import type { AgentOptions } from "../../agent/core/options";

export type AutoCompactionAgentOptions = ConstructorParameters<
  typeof Agent
>[0] & {
  readonly autoCompaction?: AgentOptions["autoCompaction"];
};

export const agentWithAutoCompaction = (
  options: AutoCompactionAgentOptions
): Agent => new Agent(options);

export const tenTokensPerMessage = (
  messages: readonly ModelMessage[]
): number => messages.length * 10;

export const tokenCompactionPolicy = ({
  retain,
  trigger,
}: {
  readonly retain: number;
  readonly trigger: number;
}): {
  readonly estimateTokens: typeof tenTokensPerMessage;
  readonly maxInputTokens: number;
  readonly retainTokens: number;
  readonly triggerTokens: number;
} => ({
  estimateTokens: tenTokensPerMessage,
  maxInputTokens: 10_000,
  retainTokens: retain,
  triggerTokens: trigger,
});

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
    timeout: 200,
  });
};

export const nextMacrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
