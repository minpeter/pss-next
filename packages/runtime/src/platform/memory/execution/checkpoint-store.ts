import { CheckpointCorruptionError } from "../../../execution/host/checkpoint-corruption";
import {
  decideCheckpointVersionWrite,
  decideLeaseFencedCheckpointWrite,
} from "../../../execution/host/checkpoint-write-decision";
import type {
  Checkpoint,
  CheckpointStore,
  CheckpointWriteResult,
  LeaseFencedCheckpointStore,
  LeaseFencedCheckpointWriteOptions,
  LeaseFencedCheckpointWriteResult,
  TurnRecord,
} from "../../../execution/host/types";
import type { ExecutionState } from "./state";

export class InMemoryCheckpointStore
  implements CheckpointStore, LeaseFencedCheckpointStore
{
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  append(
    checkpoint: Checkpoint,
    options: { readonly expectedVersion: number }
  ): Promise<CheckpointWriteResult> {
    const state = this.#state();
    const run = state.turns.get(checkpoint.runId);
    const decision = decideCheckpointVersionWrite(
      run?.checkpointVersion ?? 0,
      options.expectedVersion
    );
    if (!decision.ok) {
      return Promise.resolve(decision);
    }
    this.#persist(state, checkpoint, run);
    return Promise.resolve({ ok: true, version: checkpoint.version });
  }

  appendFenced(
    checkpoint: Checkpoint,
    options: LeaseFencedCheckpointWriteOptions
  ): Promise<LeaseFencedCheckpointWriteResult> {
    const state = this.#state();
    const decision = decideLeaseFencedCheckpointWrite(
      checkpoint.runId,
      state.turns.get(checkpoint.runId) ?? null,
      checkpoint,
      options
    );
    if (!decision.ok) {
      return Promise.resolve(decision);
    }
    this.#persist(state, checkpoint, decision.run);
    return Promise.resolve({ ok: true, version: checkpoint.version });
  }

  latest(runId: string): Promise<Checkpoint | null> {
    const state = this.#state();
    const run = state.turns.get(runId);
    if (!(run && run.runId === runId && run.checkpointVersion > 0)) {
      return Promise.resolve(null);
    }
    const checkpoints = state.checkpoints.get(runId) ?? [];
    const checkpoint = checkpoints.find(
      (candidate) => candidate.version === run.checkpointVersion
    );
    if (!checkpoint) {
      throw new CheckpointCorruptionError(runId, run.checkpointVersion);
    }
    return Promise.resolve(structuredClone(checkpoint));
  }

  #persist(
    state: ExecutionState,
    checkpoint: Checkpoint,
    run: TurnRecord | undefined
  ): void {
    const checkpoints = state.checkpoints.get(checkpoint.runId) ?? [];
    checkpoints.push(structuredClone(checkpoint));
    state.checkpoints.set(checkpoint.runId, checkpoints);
    if (run) {
      state.turns.set(checkpoint.runId, {
        ...run,
        checkpointVersion: checkpoint.version,
      });
    }
  }
}
