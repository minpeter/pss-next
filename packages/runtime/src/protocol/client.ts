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
  #nextId = 1;
  #readFailure: unknown;

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
    Promise.resolve()
      .then(() => this.#transport.write(encodeJsonl(message)))
      .catch((error) => {
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

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const closed = new Error("PSS protocol client closed");
    this.#failPending(closed);
    try {
      await this.#transport.close?.();
    } finally {
      Promise.resolve()
        .then(() => this.#iterator.return?.())
        .catch((error) => this.#notifyListenerError(error));
    }
  }

  async #read(): Promise<void> {
    const decoder = new JsonlDecoder();
    try {
      while (!this.#closed) {
        const next = await this.#iterator.next();
        if (next.done) {
          for (const message of decoder.finish()) {
            this.#handle(message);
          }
          throw new Error("PSS protocol transport closed");
        }
        for (const message of decoder.push(next.value)) {
          this.#handle(message);
        }
      }
    } catch (error) {
      this.#readFailure = error;
      this.#failPending(error);
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
      const event = message as unknown as ProtocolEvent;
      for (const listener of this.#listeners) {
        try {
          listener(event.params);
        } catch (error) {
          this.#notifyListenerError(error);
        }
      }
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
