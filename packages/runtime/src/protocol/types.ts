export const PSS_PROTOCOL_VERSION = "pss/1" as const;

export type ProtocolRequestId = string | number;
export type ProtocolMethod = "abort" | "prompt" | "state" | "steer";

export interface ProtocolAcceptedResult {
  readonly accepted: true;
}

export interface ProtocolAbortResult {
  readonly interrupted: boolean;
}

export interface ProtocolStateResult {
  readonly activeRequestId: ProtocolRequestId | null;
  readonly status: "idle" | "running";
  readonly threadKey?: string;
}

export interface ProtocolRequest {
  readonly id: ProtocolRequestId;
  readonly jsonrpc: "2.0";
  readonly method: ProtocolMethod;
  readonly params?: Record<string, unknown>;
  readonly protocol: typeof PSS_PROTOCOL_VERSION;
}

export interface ProtocolError {
  readonly code: number;
  readonly data?: unknown;
  readonly message: string;
}

export interface ProtocolSuccess {
  readonly id: ProtocolRequestId;
  readonly jsonrpc: "2.0";
  readonly protocol: typeof PSS_PROTOCOL_VERSION;
  readonly result: unknown;
}

export interface ProtocolFailure {
  readonly error: ProtocolError;
  readonly id: ProtocolRequestId | null;
  readonly jsonrpc: "2.0";
  readonly protocol: typeof PSS_PROTOCOL_VERSION;
}

export interface ProtocolEvent {
  readonly jsonrpc: "2.0";
  readonly method: "event";
  readonly params: {
    readonly event: unknown;
    readonly requestId?: ProtocolRequestId;
  };
  readonly protocol: typeof PSS_PROTOCOL_VERSION;
}

export type ProtocolResponse = ProtocolFailure | ProtocolSuccess;
export type ProtocolMessage =
  | ProtocolEvent
  | ProtocolRequest
  | ProtocolResponse;

export class ProtocolRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: ProtocolError) {
    super(error.message);
    this.name = "ProtocolRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}
