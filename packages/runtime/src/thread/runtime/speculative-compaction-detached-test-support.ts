import type { ModelMessage } from "ai";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import type { AgentCompaction } from "./auto-compaction-types";
import { speculativeCompaction } from "./speculative-compaction";

export const DEADLINE_MS = 15_000;

export interface HangingProvider {
  called: number;
  readonly firstGate: ReturnType<typeof createDeferred>;
  signal: AbortSignal | undefined;
  readonly started: ReturnType<typeof createDeferred>;
}

/** The first provider call hangs until firstGate resolves; later calls return. */
export function hangingSummaryProvider(): {
  readonly model: { readonly model: ReturnType<typeof createCallbackModel> };
  readonly provider: HangingProvider;
} {
  const provider: HangingProvider = {
    called: 0,
    firstGate: createDeferred(),
    signal: undefined,
    started: createDeferred(),
  };
  return {
    model: {
      model: createCallbackModel(async ({ signal }) => {
        provider.called += 1;
        provider.signal = signal;
        provider.started.resolve();
        if (provider.called === 1) {
          await provider.firstGate.promise;
        }
        return [assistantMessage(`detached summary ${provider.called}`)];
      }),
    },
    provider,
  };
}

export function policy(): AgentCompaction {
  return speculativeCompaction({
    estimateTokens: (messages) => messages.length * 10,
    maxInputTokens: 100,
    prepareRatio: 0.5,
    promoteRatio: 0.7,
    retainRatio: 0.2,
  });
}

export async function stateWithHistory(key: string): Promise<ThreadState> {
  const state = new ThreadState({
    key,
    store: new MemoryThreadStore(),
  });
  await state.ensureLoaded();
  const history: readonly ModelMessage[] = [
    { content: "1", role: "user" },
    assistantMessage("2"),
    { content: "3", role: "user" },
    assistantMessage("4"),
    { content: "5", role: "user" },
    assistantMessage("6"),
  ];
  for (const message of history) {
    state.history.appendModelMessage(message);
  }
  return state;
}
