import { randomUUID } from "node:crypto";
import {
  ackThreadInputClaim,
  admitThreadInput,
  claimNextThreadInput,
  promoteThreadInputClaim,
  releaseThreadInputClaim,
} from "../../../execution/host/thread-input-inbox";
import { recoverThreadInputClaims } from "../../../execution/host/thread-input-recovery";
import type {
  AdmitReceipt,
  AdmitThreadInput,
  ClaimedThreadInput,
  ClaimThreadInputOptions,
  RecoverThreadInputClaimsOptions,
  RecoverThreadInputClaimsResult,
  ThreadInputBoundary,
  ThreadInputInbox,
  ThreadInputRecord,
} from "../../../execution/host/types";
import type { ExecutionState } from "./state";

export class InMemoryThreadInputInbox implements ThreadInputInbox {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  admit(input: AdmitThreadInput): Promise<AdmitReceipt> {
    return Promise.resolve().then(() => {
      const state = this.#state();
      const current = state.inputsByThread.get(input.threadKey) ?? [];
      const transition = admitThreadInput(current, input);
      state.inputsByThread.set(
        input.threadKey,
        transition.records.map((record) => structuredClone(record))
      );
      return {
        duplicate: transition.receipt.duplicate,
        record: structuredClone(transition.receipt.record),
      };
    });
  }

  claimNext(
    threadKey: string,
    boundary: ThreadInputBoundary,
    options: ClaimThreadInputOptions = {}
  ): Promise<ClaimedThreadInput | null> {
    const state = this.#state();
    const current = state.inputsByThread.get(threadKey) ?? [];
    const transition = claimNextThreadInput(
      current,
      threadKey,
      boundary,
      randomUUID(),
      options
    );
    state.inputsByThread.set(
      threadKey,
      transition.records.map((record) => structuredClone(record))
    );
    return Promise.resolve(
      transition.record ? structuredClone(transition.record) : null
    );
  }

  releaseClaim(claim: ClaimedThreadInput): Promise<ThreadInputRecord | null> {
    const state = this.#state();
    const current = state.inputsByThread.get(claim.threadKey) ?? [];
    const transition = releaseThreadInputClaim(current, claim);
    state.inputsByThread.set(
      claim.threadKey,
      transition.records.map((record) => structuredClone(record))
    );
    return Promise.resolve(
      transition.record ? structuredClone(transition.record) : null
    );
  }

  markPromoted(claim: ClaimedThreadInput): Promise<ThreadInputRecord | null> {
    const state = this.#state();
    const current = state.inputsByThread.get(claim.threadKey) ?? [];
    const transition = promoteThreadInputClaim(current, claim);
    state.inputsByThread.set(
      claim.threadKey,
      transition.records.map((record) => structuredClone(record))
    );
    return Promise.resolve(
      transition.record ? structuredClone(transition.record) : null
    );
  }

  ack(record: ThreadInputRecord): Promise<ThreadInputRecord | null> {
    const state = this.#state();
    const current = state.inputsByThread.get(record.threadKey) ?? [];
    const transition = ackThreadInputClaim(current, record);
    state.inputsByThread.set(
      record.threadKey,
      transition.records.map((candidate) => structuredClone(candidate))
    );
    return Promise.resolve(
      transition.record ? structuredClone(transition.record) : null
    );
  }

  recoverClaims(
    threadKey: string,
    options: RecoverThreadInputClaimsOptions = {}
  ): Promise<RecoverThreadInputClaimsResult> {
    options.signal?.throwIfAborted();
    const state = this.#state();
    const current = state.inputsByThread.get(threadKey) ?? [];
    const transition = recoverThreadInputClaims(current, threadKey);
    state.inputsByThread.set(
      threadKey,
      transition.records.map((record) => structuredClone(record))
    );
    return Promise.resolve({
      acked: transition.acked.map((record) => structuredClone(record)),
      released: transition.released.map((record) => structuredClone(record)),
    });
  }
}
