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
  #nextId = 1;
  #readFailure: unknown;
  readonly #reader: Promise<void>;

  constructor(transport: ProtocolTransport) {
    this.#transport = transport;
    this.#reader = this.#read();
  }

  onEvent(listener: (event: ProtocolEvent["params"]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  request<T = unknown>(
    method: ProtocolMethod,
    params?: Record<string, unknown>
  ): Promise<T> {
    if (this.#readFailure !== undefined) {
      return Promise.reject(this.#readFailure);
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
    Promise.resolve(this.#transport.write(encodeJsonl(message))).catch(
      (error) => {
        this.#pendingReject(id, error);
      }
    );
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
    await this.#transport.close?.();
    await this.#reader;
  }

  async #read(): Promise<void> {
    const decoder = new JsonlDecoder();
    try {
      for await (const chunk of this.#transport.readable) {
        for (const message of decoder.push(chunk)) {
          this.#handle(message);
        }
      }
      for (const message of decoder.finish()) {
        this.#handle(message);
      }
      throw new Error("PSS protocol transport closed");
    } catch (error) {
      this.#readFailure = error;
      for (const pending of this.#pending.values()) {
        pending.reject(error);
      }
      this.#pending.clear();
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
        listener(event.params);
      }
      return;
    }
    const response = message as unknown as ProtocolResponse;
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

  #pendingReject(id: ProtocolRequestId, error: unknown): void {
    const pending = this.#pending.get(id);
    if (pending) {
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}
