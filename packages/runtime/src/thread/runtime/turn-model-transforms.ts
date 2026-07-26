import type { AgentHookRuntime } from "../../agent/core/hook-runtime";
import type { RunAgentLoopOptions } from "../../agent/loop/types";
import type { ThreadState } from "../state/thread-state";

interface TurnModelTransforms {
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
  return {
    transformModelContext: (messages, signal) =>
      hookRuntime.transformModelContext(
        threadKey,
        { messages },
        state.modelSnapshot(),
        signal
      ),
    transformModelStep: (messages, signal) =>
      hookRuntime.transformModelStep(
        threadKey,
        messages,
        state.modelSnapshot(),
        signal
      ),
  };
}
