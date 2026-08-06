import { encodeJsonl, JsonlDecoder } from "./jsonl";
import {
  type ProtocolError,
  type ProtocolMethod,
  type ProtocolRequest,
  type ProtocolRequestId,
  PSS_PROTOCOL_VERSION,
} from "./types";

export interface ProtocolServerHandler {
  handle(
    method: ProtocolMethod,
    params: Record<string, unknown>,
    context: {
      defer?(work: Promise<unknown>): void;
      emit(event: unknown, requestId?: ProtocolRequestId): void;
      readonly requestId: ProtocolRequestId;
    }
  ): Promise<unknown> | unknown;
}

export interface ProtocolServerIo {
  readonly readable: AsyncIterable<string | Uint8Array>;
  write(data: string): Promise<void> | void;
}

/** Serves requests concurrently so steer and abort can affect a running prompt. */
export async function servePssProtocol(
  io: ProtocolServerIo,
  handler: ProtocolServerHandler
): Promise<void> {
  const decoder = new JsonlDecoder();
  const active = new Set<Promise<void>>();
  const background = new Set<Promise<unknown>>();
  let writeFailure: unknown;
  let writes = Promise.resolve();
  const write = (value: unknown): void => {
    if (writeFailure !== undefined) {
      throw writeFailure;
    }
    const frame = encodeJsonl(value);
    writes = writes.then(async () => {
      if (writeFailure !== undefined) {
        throw writeFailure;
      }
      try {
        await io.write(frame);
      } catch (error) {
        writeFailure = error;
        throw error;
      }
    });
    writes.catch(() => undefined);
  };
  const failure = (id: ProtocolRequestId | null, error: ProtocolError): void =>
    write({ error, id, jsonrpc: "2.0", protocol: PSS_PROTOCOL_VERSION });
  const dispatch = (value: unknown): void => {
    if (!(value && typeof value === "object")) {
      failure(null, { code: -32_600, message: "Invalid Request" });
      return;
    }
    const candidate = value as Partial<ProtocolRequest>;
    if (!isRequest(candidate)) {
      failure(isRequestId(candidate.id) ? candidate.id : null, {
        code: candidate.protocol === PSS_PROTOCOL_VERSION ? -32_600 : -32_001,
        message:
          candidate.protocol === PSS_PROTOCOL_VERSION
            ? "Invalid Request"
            : "Unsupported protocol version",
      });
      return;
    }
    const request = candidate as ProtocolRequest;
    if (hasInvalidParams(request.params)) {
      failure(request.id, { code: -32_602, message: "Invalid params" });
      return;
    }
    const operation = Promise.resolve()
      .then(() =>
        handler.handle(request.method, request.params ?? {}, {
          defer: (work) => {
            const tracked = Promise.resolve(work).finally(() =>
              background.delete(tracked)
            );
            tracked.catch(() => undefined);
            background.add(tracked);
          },
          emit: (event, requestId = request.id) =>
            write({
              jsonrpc: "2.0",
              method: "event",
              params: { event, requestId },
              protocol: PSS_PROTOCOL_VERSION,
            }),
          requestId: request.id,
        })
      )
      .then((result) => {
        if (result === undefined) {
          throw new Error("Protocol handlers must return a JSON result");
        }
        write({
          id: request.id,
          jsonrpc: "2.0",
          protocol: PSS_PROTOCOL_VERSION,
          result,
        });
      })
      .catch((error: unknown) => failure(request.id, rpcError(error)))
      .finally(() => active.delete(operation));
    active.add(operation);
  };

  const handleDecoded = (
    results: ReturnType<JsonlDecoder["pushResults"]>
  ): void => {
    for (const result of results) {
      if ("error" in result) {
        failure(null, {
          code: -32_700,
          message: "Parse error",
          data: errorMessage(result.error),
        });
      } else {
        dispatch(result.value);
      }
    }
  };
  for await (const chunk of io.readable) {
    handleDecoded(decoder.pushResults(chunk));
  }
  handleDecoded(decoder.finishResults());
  await Promise.allSettled(active);
  await Promise.allSettled(background);
  await writes;
}

function isRequest(value: Partial<ProtocolRequest>): value is ProtocolRequest {
  return (
    value.jsonrpc === "2.0" &&
    value.protocol === PSS_PROTOCOL_VERSION &&
    isRequestId(value.id) &&
    isMethod(value.method)
  );
}

function isRequestId(value: unknown): value is ProtocolRequestId {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= 128) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function hasInvalidParams(value: unknown): boolean {
  return (
    value !== undefined &&
    (!(value && typeof value === "object") || Array.isArray(value))
  );
}

function isMethod(value: unknown): value is ProtocolMethod {
  return (
    value === "prompt" ||
    value === "steer" ||
    value === "abort" ||
    value === "state"
  );
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function rpcError(error: unknown): ProtocolError {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error
  ) {
    const value = error as { code: unknown; data?: unknown; message: unknown };
    if (
      typeof value.code === "number" &&
      Number.isInteger(value.code) &&
      Number.isFinite(value.code) &&
      typeof value.message === "string"
    ) {
      return {
        code: value.code,
        message: value.message,
        ...(value.data === undefined ? {} : { data: value.data }),
      };
    }
  }
  return { code: -32_603, message: errorMessage(error) };
}
