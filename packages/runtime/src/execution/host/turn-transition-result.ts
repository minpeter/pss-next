import type { TurnLease, TurnRecord, TurnStatus } from "./types";

export interface TurnTransitionUpdate {
  readonly lease?: TurnLease | null;
  readonly status: TurnStatus;
}

export type TurnTransitionResult =
  | { readonly ok: true; readonly record: TurnRecord }
  | {
      readonly ok: false;
      readonly reason:
        | "checkpoint-conflict"
        | "lease-conflict"
        | "not-found"
        | "status-conflict";
    };
