import type { AgentHost } from "../../execution/host/types";

const liveInputs = new WeakMap<object, Map<string, Map<string, object>>>();

export function registerLiveThreadInput(
  executionHost: AgentHost | undefined,
  threadKey: string,
  messageId: string,
  owner: object
): void {
  if (!executionHost) {
    return;
  }
  let threads = liveInputs.get(executionHost.store);
  if (!threads) {
    threads = new Map();
    liveInputs.set(executionHost.store, threads);
  }
  let messages = threads.get(threadKey);
  if (!messages) {
    messages = new Map();
    threads.set(threadKey, messages);
  }
  messages.set(messageId, owner);
}

export function isLiveThreadInputOwnedByOther(
  executionHost: AgentHost | undefined,
  threadKey: string,
  messageId: string,
  owner?: object
): boolean {
  if (!executionHost) {
    return false;
  }
  const registered = liveInputs
    .get(executionHost.store)
    ?.get(threadKey)
    ?.get(messageId);
  return registered !== undefined && registered !== owner;
}

export function unregisterLiveThreadInput(
  executionHost: AgentHost | undefined,
  threadKey: string,
  messageId: string
): void {
  if (!executionHost) {
    return;
  }
  const threads = liveInputs.get(executionHost.store);
  const messages = threads?.get(threadKey);
  messages?.delete(messageId);
  if (messages?.size === 0) {
    threads?.delete(threadKey);
  }
}
