import { join } from "node:path";
import type {
  HostStoreTransaction,
  LeaseFencedCheckpointStore,
  ThreadEventLog,
} from "../../../../execution/host/types";
import { FileCheckpointStore } from "./checkpoint-store";
import { FileEventStore, FileThreadEventLog } from "./event-store";
import { FileThreadInputInbox } from "./input-inbox";
import { LockedThreadStore } from "./locked-thread-store";
import { FileNotificationInbox } from "./notification-inbox";
import { FileRunStore } from "./run-store";
import type { DataDirectoryResolver } from "./types";

export type FileExecutionStorePorts = Omit<
  HostStoreTransaction,
  "leaseFencedCheckpoints" | "threadEvents"
> & {
  readonly leaseFencedCheckpoints: LeaseFencedCheckpointStore;
  readonly threadEvents: ThreadEventLog;
};

export function createFileExecutionStorePorts(
  directory: DataDirectoryResolver,
  lock: <T>(fn: () => Promise<T>) => Promise<T>
): FileExecutionStorePorts {
  const runs = new FileRunStore(directory, lock);
  const checkpoints = new FileCheckpointStore(directory, lock, runs);
  const threads = new LockedThreadStore(
    async () => join(await directory(), "threads"),
    lock
  );
  return {
    events: new FileEventStore(directory, lock),
    inputs: new FileThreadInputInbox(directory, lock),
    leaseFencedCheckpoints: checkpoints,
    notifications: new FileNotificationInbox(directory, lock),
    checkpoints,
    threadEvents: new FileThreadEventLog(directory, lock),
    threads,
    turns: runs,
  };
}
