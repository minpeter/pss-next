import type { Tool, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import type {
  AgentHost,
  Checkpoint,
  TurnRecord,
} from "../execution/host/types";
import { createInMemoryHost } from "../platform/memory";

export interface GenerateTextToolOptions {
  readonly tools?: ToolSet;
}

export const createQueuedUserTurnRun = (runId = "run-1"): TurnRecord => ({
  checkpointVersion: 0,
  kind: "user-turn",
  rootRunId: runId,
  runId,
  threadKey: "thread-1",
  status: "queued",
});

export function checkpointedTool(
  retryPolicy: "idempotent" | "manual-recovery" | "pure",
  execute: (input: unknown, options: unknown) => unknown
): Tool & { readonly retryPolicy: "idempotent" | "manual-recovery" | "pure" } {
  return {
    ...tool({
      execute,
      inputSchema: jsonSchema({
        additionalProperties: false,
        properties: {},
        type: "object",
      }),
    }),
    retryPolicy,
  };
}

export function toolOptions(toolCallId: string, signal: AbortSignal) {
  return {
    abortSignal: signal,
    context: undefined,
    messages: [],
    toolCallId,
  };
}

export function createCheckpointSpyHost(): {
  readonly checkpoints: Checkpoint[];
  readonly host: AgentHost;
} {
  const baseHost = createInMemoryHost();
  const checkpoints: Checkpoint[] = [];
  const deleteThread = baseHost.store.deleteThread?.bind(baseHost.store);
  return {
    checkpoints,
    host: {
      diagnostics: baseHost.diagnostics,
      scheduler: baseHost.scheduler,
      store: {
        checkpoints: {
          append: async (checkpoint, options) => {
            checkpoints.push(checkpoint);
            return await baseHost.store.checkpoints.append(checkpoint, options);
          },
          latest: (runId) => baseHost.store.checkpoints.latest(runId),
        },
        ...(deleteThread === undefined ? {} : { deleteThread }),
        events: baseHost.store.events,
        inputs: baseHost.store.inputs,
        notifications: baseHost.store.notifications,
        turns: baseHost.store.turns,
        threads: baseHost.store.threads,
        transaction: (fn) => baseHost.store.transaction(fn),
      },
    },
  };
}
