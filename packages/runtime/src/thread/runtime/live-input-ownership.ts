import type { AgentHost } from "../../execution/host/types";
import { deferred } from "../../internal/deferred";

interface LiveInputOwner {
  readonly owner: object;
  readonly released: ReturnType<typeof deferred<void>>;
}
const liveInputs = new WeakMap<
  object,
  Map<string, Map<string, LiveInputOwner>>
>();

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
  messages.set(messageId, { owner, released: deferred<void>() });
}

export function liveThreadInputOwnedByOther(
  executionHost: AgentHost | undefined,
  threadKey: string,
  messageId: string,
  owner?: object
): Promise<void> | undefined {
  if (!executionHost) {
    return;
  }
  const registered = liveInputs
    .get(executionHost.store)
    ?.get(threadKey)
    ?.get(messageId);
  return registered && registered.owner !== owner
    ? registered.released.promise
    : undefined;
}

export function isLiveThreadInputOwnedByOther(
  executionHost: AgentHost | undefined,
  threadKey: string,
  messageId: string,
  owner?: object
): boolean {
  return (
    liveThreadInputOwnedByOther(executionHost, threadKey, messageId, owner) !==
    undefined
  );
}

export function unregisterLiveThreadInput(
  executionHost: AgentHost | undefined,
  threadKey: string,
  messageId: string,
  owner?: object
): void {
  if (!executionHost) {
    return;
  }
  const threads = liveInputs.get(executionHost.store);
  const messages = threads?.get(threadKey);
  const registered = messages?.get(messageId);
  if (!registered || (owner !== undefined && registered.owner !== owner)) {
    return;
  }
  messages?.delete(messageId);
  registered.released.resolve(undefined);
  if (messages?.size === 0) {
    threads?.delete(threadKey);
  }
}
