import type { ClaimedThreadInput } from "../../execution/host/types";
import type { AgentEvent, RuntimeInput } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { QueuedThreadExecutionRun } from "../runtime/execution";
import {
  cleanupStagedRuntimeAttachments,
  type HostAttachmentStore,
  type RuntimeAttachmentReference,
  stageUserInputAttachments,
  userInputRequiresAttachmentProcessing,
} from "./attachments";
import type { AgentInput, UserInput } from "./input";
import { attachInputMeta } from "./input-meta";
import { normalizeAgentInput } from "./input-normalization";

export type RuntimeInputPlacement = RuntimeInput["placement"];

export interface QueuedRuntimeInput {
  readonly canonical?: boolean;
  readonly input: UserInput;
  readonly placement: RuntimeInputPlacement;
}

export interface RuntimeInputState {
  closedReason?: string;
  pending: Promise<void>;
  placement?: RuntimeInputPlacement;
  readonly queue: QueuedRuntimeInput[];
  steerPlacement?: RuntimeInputPlacement;
}

export interface QueuedInput {
  readonly acceptedEvent?: AgentEvent;
  readonly awaitBoundaries?: boolean;
  readonly durableInput?: boolean;
  readonly durableInputClaim?: ClaimedThreadInput;
  readonly durableInputKind?: "follow-up" | "send";
  readonly durableMessageId?: string;
  readonly executionRun?: QueuedThreadExecutionRun;
  readonly initialEvents: AgentEvent[];
  readonly input?: UserInput;
  readonly preUserRuntimeInputs: QueuedRuntimeInput[];
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
}

export function createRuntimeInputState(
  queue: QueuedRuntimeInput[]
): RuntimeInputState {
  return {
    pending: Promise.resolve(),
    queue,
  };
}

export function addSteeringInput(
  runtimeInput: RuntimeInputState,
  input: AgentInput,
  attachmentStore: HostAttachmentStore | undefined
): Promise<void> {
  const placement = currentSteeringPlacement(runtimeInput);
  const next = runtimeInput.pending.then(async () => {
    const stagedRefs: RuntimeAttachmentReference[] = [];
    assertRuntimeInputOpen(runtimeInput);

    const acceptedInput = attachInputMeta(normalizeAgentInput(input), {
      source: "steer",
      streaming: "steer",
    });
    try {
      const staged = userInputRequiresAttachmentProcessing(acceptedInput)
        ? await stageUserInputAttachments(acceptedInput, attachmentStore, {
            stagedRefs,
          })
        : acceptedInput;
      assertRuntimeInputOpen(runtimeInput);
      queueRuntimeInput(runtimeInput, {
        input: staged,
        placement,
      });
    } catch (error) {
      await cleanupStagedRuntimeAttachments(attachmentStore, stagedRefs);
      throw error;
    }
  });
  runtimeInput.pending = next.catch(() => undefined);
  return next;
}

export function assertRuntimeInputOpen(runtimeInput: RuntimeInputState): void {
  if (runtimeInput.closedReason) {
    throw runtimeInputClosedError(runtimeInput.closedReason);
  }
}

export function currentSteeringPlacement(
  runtimeInput: RuntimeInputState
): RuntimeInputPlacement {
  return runtimeInput.steerPlacement ?? runtimeInput.placement ?? "step-end";
}

export function closeRuntimeInput(
  runtimeInput: RuntimeInputState | undefined,
  reason = "the run reached a terminal state"
): void {
  if (runtimeInput && !runtimeInput.closedReason) {
    runtimeInput.closedReason = reason;
    runtimeInput.placement = undefined;
  }
}

export async function withRuntimeInputWindow<T>(
  runtimeInput: RuntimeInputState,
  placement: RuntimeInputPlacement,
  callback: () => Promise<T>
): Promise<T> {
  const previousSteerPlacement = runtimeInput.steerPlacement;
  runtimeInput.placement = placement;
  runtimeInput.steerPlacement = placement;
  try {
    return await callback();
  } finally {
    runtimeInput.placement = undefined;
    runtimeInput.steerPlacement = previousSteerPlacement;
  }
}

export function shiftRuntimeInput(
  runtimeInput: RuntimeInputState,
  placement: RuntimeInputPlacement
): QueuedRuntimeInput | undefined {
  const index = runtimeInput.queue.findIndex(
    (input) => input.placement === placement
  );
  if (index === -1) {
    return;
  }

  return runtimeInput.queue.splice(index, 1)[0];
}

export function queueRuntimeInput(
  runtimeInput: RuntimeInputState,
  input: QueuedRuntimeInput
): void {
  runtimeInput.queue.push(input);
}

function runtimeInputClosedError(reason: string): Error {
  return new Error(`thread.steer() cannot be used after ${reason}`);
}
