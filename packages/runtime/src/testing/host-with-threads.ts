import type { AgentHost } from "../execution/host/types";
import { createInMemoryHost } from "../platform/memory";
import type { HostAttachmentStore } from "../thread/input/attachments";
import type { ThreadStore } from "../thread/store/types";

/** Test helper: full AgentHost with a custom threads port. */
export function hostWithThreads(
  threadStore: ThreadStore,
  attachmentStore?: HostAttachmentStore
): AgentHost {
  const base = createInMemoryHost();
  return {
    attachmentStore: attachmentStore ?? base.attachmentStore,
    diagnostics: base.diagnostics,
    scheduler: base.scheduler,
    store: {
      checkpoints: base.store.checkpoints,
      events: base.store.events,
      inputs: base.store.inputs,
      leaseFencedCheckpoints: base.store.leaseFencedCheckpoints,
      notifications: base.store.notifications,
      threadEvents: base.store.threadEvents,
      threads: threadStore,
      turns: base.store.turns,
      transaction: (fn) =>
        base.store.transaction(async (tx) =>
          fn({
            ...tx,
            threads: threadStore,
          })
        ),
    },
  };
}
