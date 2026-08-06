import type { Agent } from "../../agent/core/agent";
import type { AgentEvent } from "../protocol/events";
import type {
  CommitResult,
  StoredThread,
  ThreadStore,
  ThreadStoreCommit,
} from "../store/types";

export const collect = async (
  run: Awaited<ReturnType<Agent["send"]>>
): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
};

export class SpyStore implements ThreadStore {
  readonly commits: Array<{
    key: string;
    next: ThreadStoreCommit;
    expectedVersion: string | null;
  }> = [];
  loadCount = 0;
  loadGate?: Promise<void>;
  readonly threads = new Map<string, StoredThread>();

  async load(key: string): Promise<StoredThread | null> {
    this.loadCount += 1;
    await this.loadGate;
    const stored = this.threads.get(key);
    return stored ? structuredClone(stored) : null;
  }

  delete(key: string): Promise<void> {
    this.threads.delete(key);
    return Promise.resolve();
  }

  commit(
    key: string,
    next: ThreadStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    const current = this.threads.get(key);
    const currentVersion = current?.version ?? null;
    if (options.expectedVersion !== currentVersion) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    const version = String(Number(current?.version ?? 0) + 1);
    const stored = structuredClone({ state: next.state, version });
    this.commits.push({
      key,
      next: structuredClone(next),
      expectedVersion: options.expectedVersion,
    });
    this.threads.set(key, stored);
    return Promise.resolve({ ok: true, version });
  }
}

export class ConflictOnCommitStore extends SpyStore {
  commitCount = 0;
  conflictOnCommit = 1;

  override commit(
    key: string,
    next: ThreadStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    this.commitCount += 1;
    if (this.commitCount === this.conflictOnCommit) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    return super.commit(key, next, options);
  }
}

export class RejectOnCompactionCommitStore extends SpyStore {
  override commit(
    key: string,
    next: ThreadStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    if (
      typeof next.state === "object" &&
      next.state !== null &&
      "schemaVersion" in next.state &&
      next.state.schemaVersion === 2
    ) {
      return Promise.reject(new Error("compaction commit failed"));
    }

    return super.commit(key, next, options);
  }
}
