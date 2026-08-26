import type { ModelMessage } from "ai";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";

export const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};

export async function stateWithHistory(): Promise<ThreadState> {
  const state = new ThreadState({
    key: "runner-failure-test",
    store: new MemoryThreadStore(),
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
