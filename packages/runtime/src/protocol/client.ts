import { encodeJsonl, JsonlDecoder } from "./jsonl";
import {
  type ProtocolAbortResult,
  type ProtocolAcceptedResult,
  type ProtocolEvent,
  type ProtocolMethod,
  type ProtocolRequestId,
  type ProtocolResponse,
  ProtocolRpcError,
  type ProtocolStateResult,
  PSS_PROTOCOL_VERSION,
} from "./types";

export interface ProtocolTransport {
  close?(): Promise<void> | void;
  readonly readable: AsyncIterable<string | Uint8Array>;
  write(data: string): Promise<void> | void;
}

export class PssProtocolClient {
  readonly #transport: ProtocolTransport;
  readonly #pending = new Map<
    ProtocolRequestId,
    { reject(error: unknown): void; resolve(value: unknown): void }
  >();
  readonly #listeners = new Set<(event: ProtocolEvent["params"]) => void>();
  readonly #listenerErrorHandlers = new Set<(error: unknown) => void>();
  readonly #iterator: AsyncIterator<string | Uint8Array>;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #nextId = 1;
  #readFailure: unknown;
  #writeTail = Promise.resolve();

  constructor(transport: ProtocolTransport) {
    this.#transport = transport;
    this.#iterator = transport.readable[Symbol.asyncIterator]();
    this.#read().catch((error) => this.#notifyListenerError(error));
  }

  onEvent(listener: (event: ProtocolEvent["params"]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onEventError(listener: (error: unknown) => void): () => void {
    this.#listenerErrorHandlers.add(listener);
    return () => this.#listenerErrorHandlers.delete(listener);
  }

  request<T = unknown>(
    method: ProtocolMethod,
    params?: Record<string, unknown>
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error("PSS protocol client is closed"));
    }
    if (this.#readFailure !== undefined) {
      return Promise.reject(this.#readFailure);
    }
    if (!Number.isSafeInteger(this.#nextId)) {
      return Promise.reject(
        new Error("PSS protocol request id space exhausted")
      );
    }
    const id = this.#nextId++;
    const result = new Promise<T>((resolve, reject) =>
      this.#pending.set(id, {
        reject,
        resolve: (value) => resolve(value as T),
      })
    );
    const message = {
      id,
      jsonrpc: "2.0" as const,
      method,
      ...(params ? { params } : {}),
      protocol: PSS_PROTOCOL_VERSION,
    };
    const write = this.#writeTail.then(() => {
      if (this.#closed) {
        throw new Error("PSS protocol client is closed");
      }
      if (this.#readFailure !== undefined) {
        throw this.#readFailure;
      }
      return this.#transport.write(encodeJsonl(message));
    });
    this.#writeTail = write.then(
      () => undefined,
      () => undefined
    );
    write.catch((error) => {
      this.#pendingReject(id, error);
    });
    return result;
  }

  prompt(prompt: string): Promise<ProtocolAcceptedResult> {
    return this.request("prompt", { prompt });
  }
  steer(prompt: string): Promise<ProtocolAcceptedResult> {
    return this.request("steer", { prompt });
  }
  abort(): Promise<ProtocolAbortResult> {
    return this.request("abort");
  }
  state(): Promise<ProtocolStateResult> {
    return this.request("state");
  }

  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#failPending(new Error("PSS protocol client closed"));
    this.#closePromise = (async () => {
      try {
        await this.#transport.close?.();
      } finally {
        try {
          Promise.resolve(this.#iterator.return?.()).catch((error) =>
            this.#notifyListenerError(error)
          );
        } catch (error) {
          this.#notifyListenerError(error);
        }
      }
    })();
    return this.#closePromise;
  }

  async #read(): Promise<void> {
    const decoder = new JsonlDecoder();
    try {
      while (!this.#closed) {
        const next = await this.#iterator.next();
        if (this.#closed) {
          return;
        }
        if (next.done) {
          this.#handleDecoded(decoder.finishResults());
          throw new Error("PSS protocol transport closed");
        }
        this.#handleDecoded(decoder.pushResults(next.value));
      }
    } catch (error) {
      this.#readFailure = error;
      this.#failPending(error);
    }
  }

  #handleDecoded(results: ReturnType<JsonlDecoder["pushResults"]>): void {
    for (const result of results) {
      if (this.#closed) {
        return;
      }
      if ("error" in result) {
        throw result.error;
      }
      this.#handle(result.value);
    }
  }

  #handle(value: unknown): void {
    if (!(value && typeof value === "object")) {
      throw new Error("Invalid PSS protocol message");
    }
    const message = value as Record<string, unknown>;
    if (
      message.protocol !== PSS_PROTOCOL_VERSION ||
      message.jsonrpc !== "2.0"
    ) {
      throw new Error("Unsupported PSS protocol version");
    }
    if (message.method === "event") {
      this.#emit((message as unknown as ProtocolEvent).params);
      return;
    }
    const response = message as unknown as ProtocolResponse;
    if (!isResponseId(response.id)) {
      throw new Error("Invalid PSS protocol response id");
    }
    if ("error" in response && !isProtocolError(response.error)) {
      throw new Error("Invalid PSS protocol error");
    }
    if (!("error" in response || Object.hasOwn(response, "result"))) {
      throw new Error("Invalid PSS protocol result");
    }
    const pending =
      response.id === null ? undefined : this.#pending.get(response.id);
    if (!pending) {
      return;
    }
    this.#pending.delete(response.id as ProtocolRequestId);
    if ("error" in response) {
      pending.reject(new ProtocolRpcError(response.error));
    } else {
      pending.resolve(response.result);
    }
  }

  #emit(event: ProtocolEvent["params"]): void {
    for (const listener of this.#listeners) {
      if (this.#closed) {
        break;
      }
      try {
        listener(event);
      } catch (error) {
        this.#notifyListenerError(error);
      }
    }
  }

  #failPending(error: unknown): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #notifyListenerError(error: unknown): void {
    for (const listener of this.#listenerErrorHandlers) {
      try {
        listener(error);
      } catch {
        // Error observers are isolated from protocol processing too.
      }
    }
  }

  #pendingReject(id: ProtocolRequestId, error: unknown): void {
    const pending = this.#pending.get(id);
    if (pending) {
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}

function isResponseId(value: unknown): value is ProtocolRequestId | null {
  return (
    value === null ||
    (typeof value === "string" && value.length > 0 && value.length <= 128) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function isProtocolError(value: unknown): value is {
  readonly code: number;
  readonly message: string;
} {
  return Boolean(
    value &&
      typeof value === "object" &&
      "code" in value &&
      typeof value.code === "number" &&
      Number.isFinite(value.code) &&
      Number.isInteger(value.code) &&
      "message" in value &&
      typeof value.message === "string"
  );
}
