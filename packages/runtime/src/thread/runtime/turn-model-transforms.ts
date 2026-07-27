import type { AgentHookRuntime } from "../../agent/core/hook-runtime";
import type { RunAgentLoopOptions } from "../../agent/loop/types";
import type { ThreadState } from "../state/thread-state";
import type {
  ThreadContextTransformObservation,
  ThreadContextTransformObserver,
} from "./auto-compaction-types";

interface TurnModelTransforms {
  readonly latestContextTransform: ThreadContextTransformObserver;
  readonly transformModelContext: RunAgentLoopOptions["transformModelContext"];
  readonly transformModelStep: RunAgentLoopOptions["transformModelStep"];
}

export function createTurnModelTransforms({
  hookRuntime,
  state,
  threadKey,
}: {
  readonly hookRuntime: AgentHookRuntime;
  readonly state: ThreadState;
  readonly threadKey: string;
}): TurnModelTransforms {
  let latestObservation: ThreadContextTransformObservation | undefined;
  return {
    latestContextTransform: () => latestObservation,
    transformModelContext: async (messages, signal) => {
      const output = await hookRuntime.transformModelContext(
        threadKey,
        { messages },
        state.modelSnapshot(),
        signal
      );
      latestObservation = { input: messages, output };
      return output;
    },
    transformModelStep: (messages, signal) =>
      hookRuntime.transformModelStep(
        threadKey,
        messages,
        state.modelSnapshot(),
        signal
      ),
  };
}
