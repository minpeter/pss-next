import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ackThreadInputClaim,
  admitThreadInput,
  claimNextThreadInput,
  promoteThreadInputClaim,
  releaseThreadInputClaim,
} from "../../../../execution/host/thread-input-inbox";
import { recoverThreadInputClaims } from "../../../../execution/host/thread-input-recovery";
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
} from "../../../../execution/host/types";
import { readJsonFile, writeJsonFile } from "./json";
import { parseThreadInputRecords } from "./thread-input-schema";
import type { DataDirectoryResolver } from "./types";
import { encodeKey } from "./utils";

export class FileThreadInputInbox implements ThreadInputInbox {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>
  ) {
    this.#directory = directory;
    this.#lock = lock;
  }

  async admit(input: AdmitThreadInput): Promise<AdmitReceipt> {
    return await this.#lock(async () => {
      const current = await this.#getUnlocked(input.threadKey);
      const transition = admitThreadInput(current, input);
      await this.#writeUnlocked(input.threadKey, transition.records);
      return transition.receipt;
    });
  }

  async claimNext(
    threadKey: string,
    boundary: ThreadInputBoundary,
    options: ClaimThreadInputOptions = {}
  ): Promise<ClaimedThreadInput | null> {
    return await this.#lock(async () => {
      const current = await this.#getUnlocked(threadKey);
      const transition = claimNextThreadInput(
        current,
        threadKey,
        boundary,
        randomUUID(),
        options
      );
      if (transition.record) {
        await this.#writeUnlocked(threadKey, transition.records);
      }
      return transition.record;
    });
  }

  async releaseClaim(
    claim: ClaimedThreadInput
  ): Promise<ThreadInputRecord | null> {
    return await this.#lock(async () => {
      const current = await this.#getUnlocked(claim.threadKey);
      const transition = releaseThreadInputClaim(current, claim);
      if (transition.record) {
        await this.#writeUnlocked(claim.threadKey, transition.records);
      }
      return transition.record;
    });
  }

  async markPromoted(
    claim: ClaimedThreadInput
  ): Promise<ThreadInputRecord | null> {
    return await this.#lock(async () => {
      const current = await this.#getUnlocked(claim.threadKey);
      const transition = promoteThreadInputClaim(current, claim);
      if (transition.record) {
        await this.#writeUnlocked(claim.threadKey, transition.records);
      }
      return transition.record;
    });
  }

  async ack(record: ThreadInputRecord): Promise<ThreadInputRecord | null> {
    return await this.#lock(async () => {
      const current = await this.#getUnlocked(record.threadKey);
      const transition = ackThreadInputClaim(current, record);
      if (transition.record) {
        await this.#writeUnlocked(record.threadKey, transition.records);
      }
      return transition.record;
    });
  }

  async recoverClaims(
    threadKey: string,
    options: RecoverThreadInputClaimsOptions = {}
  ): Promise<RecoverThreadInputClaimsResult> {
    return await this.#lock(async () => {
      options.signal?.throwIfAborted();
      const current = await this.#getUnlocked(threadKey);
      options.signal?.throwIfAborted();
      const transition = recoverThreadInputClaims(current, threadKey);
      if (transition.acked.length > 0 || transition.released.length > 0) {
        await this.#writeUnlocked(threadKey, transition.records);
      }
      return {
        acked: transition.acked,
        released: transition.released,
      };
    });
  }

  async #getUnlocked(threadKey: string): Promise<readonly ThreadInputRecord[]> {
    return (
      (await readJsonFile(
        await this.#fileForThread(threadKey),
        parseThreadInputRecords,
        "input file"
      )) ?? []
    );
  }

  async #writeUnlocked(
    threadKey: string,
    records: readonly ThreadInputRecord[]
  ): Promise<void> {
    await writeJsonFile(await this.#fileForThread(threadKey), records);
  }

  async #fileForThread(threadKey: string): Promise<string> {
    return join(
      await this.#directory(),
      "inputs",
      `${encodeKey(threadKey)}.json`
    );
  }
}
