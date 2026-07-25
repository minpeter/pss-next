import type { RunAgentLoopOptions } from "../../agent/loop/types";
import type { PluginRuntime } from "../../plugins/plugin-runtime";
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
  pluginRuntime,
  state,
  threadKey,
}: {
  readonly pluginRuntime?: PluginRuntime;
  readonly state: ThreadState;
  readonly threadKey: string;
}): TurnModelTransforms {
  let latestObservation: ThreadContextTransformObservation | undefined;
  return {
    latestContextTransform: () => latestObservation,
    transformModelContext: pluginRuntime
      ? async (messages, signal) => {
          const output = await pluginRuntime.transformModelContext(
            threadKey,
            messages,
            state.modelSnapshot(),
            signal
          );
          latestObservation = { input: messages, output };
          return output;
        }
      : undefined,
    transformModelStep: pluginRuntime
      ? (messages, signal) =>
          pluginRuntime.transformModelStep(
            threadKey,
            messages,
            state.modelSnapshot(),
            signal
          )
      : undefined,
  };
}
