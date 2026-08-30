export type CheckpointPhase =
  | "after-model"
  | "after-notification"
  | "after-tool"
  | "before-child-run"
  | "before-model"
  | "before-notification"
  | "before-tool"
  | "child-linked"
  | "suspended";

export interface Checkpoint {
  readonly checkpointId: string;
  readonly childRunId?: string;
  readonly pendingToolCall?: unknown;
  readonly phase: CheckpointPhase;
  readonly runId: string;
  readonly runtimeState: unknown;
  readonly threadSnapshot: unknown;
  readonly version: number;
}

export type CheckpointWriteResult =
  | { readonly ok: true; readonly version: number }
  | {
      readonly currentVersion: number;
      readonly ok: false;
      readonly reason: "stale-version";
    };

export interface CheckpointStore {
  append(
    checkpoint: Checkpoint,
    options: { readonly expectedVersion: number }
  ): Promise<CheckpointWriteResult>;
  latest(runId: string): Promise<Checkpoint | null>;
}

export interface LeaseFencedCheckpointWriteOptions {
  readonly expectedLeaseId: string | null;
  readonly expectedVersion: number;
}

export type LeaseFencedCheckpointWriteResult =
  | CheckpointWriteResult
  | {
      readonly ok: false;
      readonly reason: "lease-conflict" | "not-found" | "status-conflict";
    };

export interface LeaseFencedCheckpointStore {
  appendFenced(
    checkpoint: Checkpoint,
    options: LeaseFencedCheckpointWriteOptions
  ): Promise<LeaseFencedCheckpointWriteResult>;
}
