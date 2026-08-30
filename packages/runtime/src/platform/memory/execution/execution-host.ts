import { noopRuntimeDiagnostics } from "../../../diagnostics";
import type { AgentHost, ThreadEventLog } from "../../../execution/host/types";
import { MemoryAttachmentStore } from "../storage/memory-attachment-store";
import type { InMemoryExecutionScheduler } from "./scheduler";
import { InMemoryExecutionStore } from "./store";

export interface InMemoryHost extends AgentHost {
  readonly scheduler: InMemoryExecutionScheduler;
  readonly store: AgentHost["store"] & {
    readonly threadEvents: ThreadEventLog;
  };
}

export function createInMemoryHost(): InMemoryHost {
  const store = new InMemoryExecutionStore();
  return {
    attachmentStore: new MemoryAttachmentStore(),
    diagnostics: noopRuntimeDiagnostics,
    scheduler: store.scheduler,
    store,
  };
}
