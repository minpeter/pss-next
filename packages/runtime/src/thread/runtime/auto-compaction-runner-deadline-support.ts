import type { ModelMessage } from "ai";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import type { ThreadStore } from "../store/types";

export const MAX_DEADLINE_MS = 2_147_483_647;
export const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};

export async function stateWithHistory(
  store: ThreadStore = new MemoryThreadStore()
): Promise<ThreadState> {
  const state = new ThreadState({
    key: "runner-deadline-test",
    store,
  });
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
