import type { AgentThread } from "../../thread/handle/agent-thread";
import type { AgentTurn } from "../../thread/protocol/turn";
import {
  type AgentInstrumentation,
  type AgentInstrumentationContext,
  applyAgentInstrumentations,
} from "./instrumentation";
import type { ThreadHandle } from "./thread-entry";

export function createThreadPublicHandle({
  evict,
  instrumentations,
  key,
  namespace,
  thread,
}: {
  readonly evict: (key: string) => void;
  readonly instrumentations: readonly AgentInstrumentation[];
  readonly key: string;
  readonly namespace: string | undefined;
  readonly thread: AgentThread;
}): ThreadHandle {
  const instrumentTurn = (
    turn: AgentTurn,
    context: AgentInstrumentationContext
  ): AgentTurn => applyAgentInstrumentations(turn, instrumentations, context);

  const publicHandle: ThreadHandle = {
    compact: thread.compact.bind(thread),
    delete: async () => {
      await thread.delete();
      evict(key);
    },
    dispose: async () => {
      await thread.dispose();
      evict(key);
    },
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
