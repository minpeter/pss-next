import type { ModelMessage } from "ai";
import type { AgentHookRuntime } from "../../agent/core/hook-runtime";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import type { ThreadStore } from "../store/types";
import { ThreadEventDispatcher } from "./thread-event-dispatcher";

export const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};

export async function stateWithHistory(
  store: ThreadStore = new MemoryThreadStore()
): Promise<ThreadState> {
  const state = new ThreadState({ key: "dispatcher-compaction", store });
  await state.ensureLoaded();
  const history: readonly ModelMessage[] = [
    { content: "old", role: "user" },
    assistantMessage("done"),
    { content: "tail", role: "user" },
  ];
  for (const message of history) {
    state.history.appendModelMessage(message);
  }
  return state;
}

export function dispatcher(
  state: ThreadState,
  hookRuntime: AgentHookRuntime
): ThreadEventDispatcher {
  return new ThreadEventDispatcher({
    history: () => state.modelSnapshot(),
    hookRuntime,
    signal: () => undefined,
    threadKey: "dispatcher-compaction",
  });
}
