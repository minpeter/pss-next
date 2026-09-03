export class CheckpointCorruptionError extends Error {
  readonly checkpointVersion: number;
  readonly runId: string;

  constructor(runId: string, checkpointVersion: number) {
    super(
      `Checkpoint authority for run ${runId} references missing version ${checkpointVersion}.`
    );
    this.name = "CheckpointCorruptionError";
    this.checkpointVersion = checkpointVersion;
    this.runId = runId;
  }
}
