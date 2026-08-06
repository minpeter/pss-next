import { ThreadInputDuplicateConflictError } from "./thread-input-conflict";
import { recordWithoutClaimId } from "./thread-input-recovery";
import type {
  AdmitReceipt,
  AdmitThreadInput,
  ClaimedThreadInput,
  ClaimThreadInputOptions,
  ThreadInputBoundary,
  ThreadInputPlacement,
  ThreadInputRecord,
} from "./types";

export interface ThreadInputAdmitTransition {
  readonly receipt: AdmitReceipt;
  readonly records: readonly ThreadInputRecord[];
}

export interface ThreadInputClaimTransition {
  readonly record: ClaimedThreadInput | null;
  readonly records: readonly ThreadInputRecord[];
}

export interface ThreadInputRecordTransition {
  readonly record: ThreadInputRecord | null;
  readonly records: readonly ThreadInputRecord[];
}

export function admitThreadInput(
  records: readonly ThreadInputRecord[],
  input: AdmitThreadInput
): ThreadInputAdmitTransition {
  const existing = records.find((record) => hasSameMessage(record, input));
  if (existing) {
    if (hasSameSemanticPayload(existing, input)) {
      return {
        records,
        receipt: { duplicate: true, record: existing },
      };
    }
    throw new ThreadInputDuplicateConflictError({ existing, incoming: input });
  }

  const admittedSeq = nextAdmittedSeq(records, input.threadKey);
  const record = normalizeAdmittedInput(input, admittedSeq);
  return {
    records: [...records, record],
    receipt: { duplicate: false, record },
  };
}

export function claimNextThreadInput(
  records: readonly ThreadInputRecord[],
  threadKey: string,
  boundary: ThreadInputBoundary,
  claimId: string,
  options: ClaimThreadInputOptions = {}
): ThreadInputClaimTransition {
  const candidate = [...records]
    .filter(
      (record) =>
        record.threadKey === threadKey &&
        record.status === "pending" &&
        (!options.messageId || record.messageId === options.messageId) &&
        isClaimableAtBoundary(record, boundary)
    )
    .sort((left, right) => left.admittedSeq - right.admittedSeq)
    .at(0);
  if (!candidate) {
    return { record: null, records };
  }

  const claimed: ClaimedThreadInput = {
    ...candidate,
    claimId,
    status: "claiming",
  };
  return {
    record: claimed,
    records: replaceThreadInputRecord(records, claimed),
  };
}

export function releaseThreadInputClaim(
  records: readonly ThreadInputRecord[],
  claim: ClaimedThreadInput
): ThreadInputRecordTransition {
  const current = findMatchingClaim(records, claim, "claiming");
  if (!current) {
    return { record: null, records };
  }

  const released = recordWithoutClaimId(current, "pending");
  return {
    record: released,
    records: replaceThreadInputRecord(records, released),
  };
}

export function promoteThreadInputClaim(
  records: readonly ThreadInputRecord[],
  claim: ClaimedThreadInput
): ThreadInputRecordTransition {
  const current = findMatchingClaim(records, claim, "claiming");
  if (!current) {
    return { record: null, records };
  }

  const promoted: ThreadInputRecord = {
    ...current,
    status: "promoted",
  };
  return {
    record: promoted,
    records: replaceThreadInputRecord(records, promoted),
  };
}

export function ackThreadInputClaim(
  records: readonly ThreadInputRecord[],
  claim: ThreadInputRecord
): ThreadInputRecordTransition {
  const current = findMatchingClaim(records, claim, "promoted");
  if (!current) {
    return { record: null, records };
  }

  const acked = recordWithoutClaimId(current, "acked");
  return {
    record: acked,
    records: replaceThreadInputRecord(records, acked),
  };
}

function normalizeAdmittedInput(
  input: AdmitThreadInput,
  admittedSeq: number
): ThreadInputRecord {
  const placement = normalizedPlacement(input);
  if (placement) {
    return {
      admittedAtMs: input.admittedAtMs ?? Date.now(),
      admittedSeq,
      input: structuredClone(input.input),
      kind: input.kind,
      messageId: input.messageId,
      placement,
      status: "pending",
      threadKey: input.threadKey,
    };
  }

  return {
    admittedAtMs: input.admittedAtMs ?? Date.now(),
    admittedSeq,
    input: structuredClone(input.input),
    kind: input.kind,
    messageId: input.messageId,
    status: "pending",
    threadKey: input.threadKey,
  };
}

function hasSameMessage(
  record: ThreadInputRecord,
  input: AdmitThreadInput
): boolean {
  return (
    record.threadKey === input.threadKey && record.messageId === input.messageId
  );
}

function hasSameSemanticPayload(
  record: ThreadInputRecord,
  input: AdmitThreadInput
): boolean {
  return (
    record.kind === input.kind &&
    recordSemanticPlacement(record) === normalizedPlacement(input) &&
    stableJson(record.input) === stableJson(input.input)
  );
}

function normalizedPlacement(
  input: AdmitThreadInput
): ThreadInputPlacement | undefined {
  if (input.kind !== "steer") {
    return;
  }
  return input.placement ?? "step-end";
}

function recordSemanticPlacement(
  record: ThreadInputRecord
): ThreadInputPlacement | undefined {
  if (record.kind !== "steer") {
    return;
  }
  return record.placement ?? "step-end";
}

function nextAdmittedSeq(
  records: readonly ThreadInputRecord[],
  threadKey: string
): number {
  return (
    Math.max(
      0,
      ...records
        .filter((record) => record.threadKey === threadKey)
        .map((record) => record.admittedSeq)
    ) + 1
  );
}

function isClaimableAtBoundary(
  record: ThreadInputRecord,
  boundary: ThreadInputBoundary
): boolean {
  if (record.kind !== "steer") {
    return boundary === "turn-idle";
  }
  return recordSemanticPlacement(record) === boundary;
}

function findMatchingClaim(
  records: readonly ThreadInputRecord[],
  claim: ThreadInputRecord,
  status: "claiming" | "promoted"
): ThreadInputRecord | undefined {
  if (!claim.claimId) {
    return;
  }
  return records.find(
    (record) =>
      record.threadKey === claim.threadKey &&
      record.messageId === claim.messageId &&
      record.status === status &&
      record.claimId === claim.claimId
  );
}

function replaceThreadInputRecord(
  records: readonly ThreadInputRecord[],
  replacement: ThreadInputRecord
): readonly ThreadInputRecord[] {
  return records.map((record) =>
    record.threadKey === replacement.threadKey &&
    record.messageId === replacement.messageId
      ? replacement
      : record
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries
    .map(
      ([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`
    )
    .join(",")}}`;
}
