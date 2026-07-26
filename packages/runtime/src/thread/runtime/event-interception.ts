import type { ModelMessage } from "ai";
import type { AgentHookRuntime } from "../../agent/core/hook-runtime";
import type { AgentInputEvent } from "../../agent/core/hooks";
import {
  type HostAttachmentStore,
  type RuntimeAttachmentReference,
  stageAgentEventAttachments,
} from "../input/attachments";
import type { AgentEvent } from "../protocol/events";

interface InterceptAgentEventOptions {
  readonly attachmentStore?: HostAttachmentStore;
  readonly history: () => readonly ModelMessage[];
  readonly hookRuntime: AgentHookRuntime;
  readonly signal: () => AbortSignal;
  readonly stagedRefs?: RuntimeAttachmentReference[];
  readonly threadKey: string;
}

export async function interceptAgentEvent(
  event: AgentEvent,
  options: InterceptAgentEventOptions
): Promise<AgentEvent | "handled"> {
  let processed: AgentEvent | undefined = event;
  if (isInputAcceptEvent(event)) {
    processed = await options.hookRuntime.acceptInput(
      options.threadKey,
      event,
      options.history(),
      options.signal()
    );
  }

  if (processed === undefined) {
    return "handled";
  }
  return stageAgentEventAttachments(processed, options.attachmentStore, {
    stagedRefs: options.stagedRefs,
    trustRuntimeAttachmentRefs: true,
  });
}

function isInputAcceptEvent(event: AgentEvent): event is AgentInputEvent {
  return event.type === "runtime-input" || event.type === "user-input";
}
