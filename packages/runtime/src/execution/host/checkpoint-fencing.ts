import type {
  Checkpoint,
  HostStorePorts,
  LeaseFencedCheckpointWriteOptions,
  LeaseFencedCheckpointWriteResult,
} from "./types";

export class UnsupportedCheckpointFencingError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(
      `Runtime checkpointing for run ${runId} requires HostStore.leaseFencedCheckpoints; implement the lease-fenced checkpoint capability instead of relying on legacy CheckpointStore.append.`
    );
    this.name = "UnsupportedCheckpointFencingError";
    this.runId = runId;
  }
}

export async function appendLeaseFencedCheckpoint(
  store: HostStorePorts,
  checkpoint: Checkpoint,
  options: LeaseFencedCheckpointWriteOptions
): Promise<LeaseFencedCheckpointWriteResult> {
  const capability = store.leaseFencedCheckpoints;
  if (!capability) {
    throw new UnsupportedCheckpointFencingError(checkpoint.runId);
  }
  return await capability.appendFenced(checkpoint, options);
}
