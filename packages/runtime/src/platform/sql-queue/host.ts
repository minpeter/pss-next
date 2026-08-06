import type { RuntimeDiagnosticsSink } from "../../diagnostics";
import { noopRuntimeDiagnostics } from "../../diagnostics";
import type { AgentHost } from "../../execution/host/types";
import type { HostAttachmentStore } from "../../thread/input/attachments";
import type { SqlQueueSchedulerOptions } from "./scheduler";
import { SqlQueueScheduler } from "./scheduler";
import type { SqlHostStorePort } from "./store";
import { SqlHostStore } from "./store";

export interface SqlQueueHostOptions extends SqlQueueSchedulerOptions {
  readonly attachmentStore?: HostAttachmentStore;
  readonly diagnostics?: RuntimeDiagnosticsSink;
  readonly store: SqlHostStorePort;
}

export interface SqlQueueHost extends AgentHost {
  readonly scheduler: SqlQueueScheduler;
  readonly store: SqlHostStore;
}

/** Creates a platform-neutral host backed by an injected SQL store and queue. */
export function createSqlQueueHost({
  attachmentStore,
  clock,
  diagnostics = noopRuntimeDiagnostics,
  queue,
  store,
  wake,
}: SqlQueueHostOptions): SqlQueueHost {
  return {
    attachmentStore,
    diagnostics,
    scheduler: new SqlQueueScheduler({ clock, queue, wake }),
    store: new SqlHostStore(store),
  };
}
