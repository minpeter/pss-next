import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { QueuedInput, RuntimeInputState } from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadExecutionOptions } from "../runtime/execution";
import { processQueuedInput } from "../runtime/queued-input-processor";
import type { ThreadEventDispatcher } from "../runtime/thread-event-dispatcher";
import type { ThreadState } from "../state/thread-state";
import {
  claimOrphanDurableThreadInput,
  prepareQueuedDurableInput,
} from "./durable-queue-claims";

interface ActiveTurn {
  readonly abort: AbortController;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly turnId: string;
}

export interface ThreadInputDrainLoopOptions {
  readonly activate: (turn: ActiveTurn) => void;
  readonly continueDraining: () => boolean;
  readonly deactivateRun: () => void;
  readonly events: ThreadEventDispatcher;
  readonly execution: ThreadExecutionOptions;
  readonly inputQueue: QueuedInput[];
  readonly model: ModelGenerationOptions;
  readonly release: () => void;
  readonly state: ThreadState;
  readonly threadKey: string;
}

export async function runThreadInputDrainLoop({
  activate,
  continueDraining,
  deactivateRun,
  events,
  execution,
  inputQueue,
  model,
  release,
  state,
  threadKey,
}: ThreadInputDrainLoopOptions): Promise<void> {
  let claimOrphanDurableInput = true;
  while (continueDraining()) {
    const queuedInput = inputQueue[0];
    if (queuedInput) {
      const preparation = await prepareQueuedDurableInput({
        executionHost: execution.executionHost,
        item: queuedInput,
        threadKey,
      });
      if (preparation.kind === "blocked") {
        break;
      }
      if (preparation.kind === "unavailable") {
        inputQueue.shift();
        continue;
      }
      if (preparation.kind === "prepared") {
        inputQueue.shift();
      }

      await processInput(preparation.item);
      if (
        preparation.kind === "prepared" &&
        queuedInput.durableInputKind === "follow-up"
      ) {
        claimOrphanDurableInput = false;
      }
      continue;
    }

    if (!claimOrphanDurableInput) {
      break;
    }

    claimOrphanDurableInput = false;
    const item = await claimOrphanDurableThreadInput({
      executionHost: execution.executionHost,
      threadKey,
    });
    if (!item) {
      break;
    }

    await processInput(item);
    claimOrphanDurableInput = true;
  }

  async function processInput(item: QueuedInput): Promise<void> {
    await processQueuedInput({
      activate,
      deactivateRun,
      events,
      execution,
      item,
      model,
      release,
      state,
      threadKey,
    });
  }
}
