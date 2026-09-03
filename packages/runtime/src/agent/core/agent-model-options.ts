import type { AgentHost } from "../../execution/host/types";
import type { AgentModelOptions, AgentOptions } from "./options";

export function createAgentModelOptions(
  options: AgentOptions,
  host: AgentHost
): AgentModelOptions {
  return {
    alwaysActiveTools: options.alwaysActiveTools,
    attachmentStore:
      options.host?.attachmentStore ??
      options.attachmentStore ??
      host.attachmentStore,
    contextGate:
      options.contextGate ??
      (options.compaction?.maxInputTokens
        ? {
            ...options.compaction,
            maxInputTokens: options.compaction.maxInputTokens,
          }
        : false),
    diagnostics: host.diagnostics,
    instructions: options.instructions,
    model: options.model,
    prepareModelStep: options.prepareModelStep,
    toolChoice: options.toolChoice,
    toolOrder: options.toolOrder,
    tools: options.tools,
  };
}
