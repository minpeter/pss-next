import type { UserInput } from "../../thread/protocol/events";

export type ThreadInputKind = "follow-up" | "send" | "steer";
export type ThreadInputStatus = "acked" | "claiming" | "pending" | "promoted";
export type ThreadInputBoundary =
  | "step-end"
  | "step-start"
  | "turn-idle"
  | "turn-start";
export type ThreadInputPlacement = "step-end" | "step-start" | "turn-start";

export interface ThreadInputRecord {
  readonly admittedAtMs: number;
  readonly admittedSeq: number;
  readonly claimId?: string;
  readonly input: UserInput;
  readonly kind: ThreadInputKind;
  readonly messageId: string;
  readonly placement?: ThreadInputPlacement;
  readonly status: ThreadInputStatus;
  readonly threadKey: string;
}

export interface AdmitThreadInput {
  readonly admittedAtMs?: number;
  readonly input: UserInput;
  readonly kind: ThreadInputKind;
  readonly messageId: string;
  readonly placement?: ThreadInputPlacement;
  readonly threadKey: string;
}

export interface AdmitReceipt {
  readonly duplicate: boolean;
  readonly record: ThreadInputRecord;
}

export interface ClaimedThreadInput extends ThreadInputRecord {
  readonly claimId: string;
  readonly status: "claiming";
}

export interface RecoverThreadInputClaimsResult {
  readonly acked: readonly ThreadInputRecord[];
  readonly released: readonly ThreadInputRecord[];
}

export interface RecoverThreadInputClaimsOptions {
  readonly signal?: AbortSignal;
}

export interface ClaimThreadInputOptions {
  readonly messageId?: string;
}

export interface ThreadInputInbox {
  ack(record: ThreadInputRecord): Promise<ThreadInputRecord | null>;
  admit(input: AdmitThreadInput): Promise<AdmitReceipt>;
  claimNext(
    threadKey: string,
    boundary: ThreadInputBoundary,
    options?: ClaimThreadInputOptions
  ): Promise<ClaimedThreadInput | null>;
  markPromoted(record: ClaimedThreadInput): Promise<ThreadInputRecord | null>;
  recoverClaims(
    threadKey: string,
    options?: RecoverThreadInputClaimsOptions
  ): Promise<RecoverThreadInputClaimsResult>;
  releaseClaim(record: ClaimedThreadInput): Promise<ThreadInputRecord | null>;
}
