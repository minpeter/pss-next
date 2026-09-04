import type { AgentThread } from "../../thread/handle/agent-thread";
import type { AgentTurn } from "../../thread/protocol/turn";
import {
  type AgentInstrumentation,
  type AgentInstrumentationContext,
  applyAgentInstrumentations,
} from "./instrumentation";
import type { ThreadHandle } from "./thread-entry";

type ThreadHandleLifecycle =
  | { readonly tag: "active" }
  | { readonly error: unknown; readonly tag: "delete-failed" }
  | { readonly promise: Promise<void>; readonly tag: "deleting" }
  | { readonly tag: "deleted" }
  | { readonly promise: Promise<void>; readonly tag: "disposing" }
  | { readonly tag: "disposed" };

export function createThreadPublicHandle({
  evict,
  instrumentations,
  key,
  namespace,
  thread,
}: {
  readonly evict: (key: string, handle: ThreadHandle) => void;
  readonly instrumentations: readonly AgentInstrumentation[];
  readonly key: string;
  readonly namespace: string | undefined;
  readonly thread: AgentThread;
}): ThreadHandle {
  let lifecycle: ThreadHandleLifecycle = { tag: "active" };
  const instrumentTurn = (
    turn: AgentTurn,
    context: AgentInstrumentationContext
  ): AgentTurn => applyAgentInstrumentations(turn, instrumentations, context);

  const startDeletion = (priorDisposal?: Promise<void>): Promise<void> => {
    const operation = (async () => {
      if (priorDisposal !== undefined) {
        await priorDisposal.catch(() => undefined);
      }
      await thread.delete();
    })();
    lifecycle = { promise: operation, tag: "deleting" };
    operation.then(
      () => {
        if (lifecycle.tag === "deleting" && lifecycle.promise === operation) {
          lifecycle = { tag: "deleted" };
          evict(key, publicHandle);
        }
      },
      (error: unknown) => {
        if (lifecycle.tag === "deleting" && lifecycle.promise === operation) {
          lifecycle = { error, tag: "delete-failed" };
        }
      }
    );
    return operation;
  };

  const deleteThread = (): Promise<void> => {
    switch (lifecycle.tag) {
      case "active":
      case "delete-failed":
        return startDeletion();
      case "disposing":
        return startDeletion(lifecycle.promise);
      case "deleting":
        return lifecycle.promise;
      case "deleted":
        return Promise.resolve();
      case "disposed":
        return Promise.reject(new Error("Thread handle is disposed"));
      default:
        return assertNeverLifecycle(lifecycle);
    }
  };

  const disposeThread = (): Promise<void> => {
    switch (lifecycle.tag) {
      case "active": {
        const operation = thread.dispose();
        lifecycle = { promise: operation, tag: "disposing" };
        operation.then(
          () => {
            if (
              lifecycle.tag === "disposing" &&
              lifecycle.promise === operation
            ) {
              lifecycle = { tag: "disposed" };
              evict(key, publicHandle);
            }
          },
          () => {
            if (
              lifecycle.tag === "disposing" &&
              lifecycle.promise === operation
            ) {
              if (thread.isOpen()) {
                lifecycle = { tag: "active" };
              } else {
                lifecycle = { tag: "disposed" };
                evict(key, publicHandle);
              }
            }
          }
        );
        return operation;
      }
      case "delete-failed":
        return Promise.reject(lifecycle.error);
      case "deleting":
        return lifecycle.promise;
      case "disposing":
        return lifecycle.promise;
      case "deleted":
      case "disposed":
        return Promise.resolve();
      default:
        return assertNeverLifecycle(lifecycle);
    }
  };

  const publicHandle: ThreadHandle = {
    compact: thread.compact.bind(thread),
    delete: deleteThread,
    dispose: disposeThread,
    events: (options) => thread.events(options),
    followUp: async (input) =>
      instrumentTurn(await thread.followUp(input), {
        namespace,
        operation: "follow-up",
        threadKey: key,
      }),
    interrupt: () => thread.interrupt(),
    overlay: (input) => {
      thread.overlay(input);
      return publicHandle;
    },
    send: async (input) =>
      instrumentTurn(await thread.send(input), {
        namespace,
        operation: "send",
        threadKey: key,
      }),
    steer: async (input) =>
      instrumentTurn(await thread.steer(input), {
        namespace,
        operation: "steer",
        threadKey: key,
      }),
  };
  return publicHandle;
}

function assertNeverLifecycle(lifecycle: never): never {
  throw new Error(`Unknown thread handle lifecycle: ${String(lifecycle)}`);
}
