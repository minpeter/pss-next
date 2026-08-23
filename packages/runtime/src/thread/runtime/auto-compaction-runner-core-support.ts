import type { ModelMessage } from "ai";
import { MemoryThreadStore } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import {
  encodeRuntimeAttachmentData,
  type RuntimeAttachmentReference,
} from "../input/attachments";
import { ThreadState } from "../state/thread-state";
import type { ThreadStore } from "../store/types";

export const model = {
  model: createCallbackModel(() => [assistantMessage("unused")]),
};

export async function stateWithHistory(
  store: ThreadStore = new MemoryThreadStore()
): Promise<ThreadState> {
  const state = new ThreadState({
    key: "runner-test",
    store,
  });
  await state.ensureLoaded();
  const history: ModelMessage[] = [
    { content: "old", role: "user" },
    assistantMessage("done"),
    { content: "tail", role: "user" },
  ];
  for (const message of history) {
    state.history.appendModelMessage(message);
  }
  return state;
}

export function attachmentMessage(
  ref: RuntimeAttachmentReference
): ModelMessage {
  return {
    content: [
      {
        data: encodeRuntimeAttachmentData(ref),
        filename: "payload.bin",
        mediaType: "application/octet-stream",
        type: "file",
      },
    ],
    role: "user",
  };
}
