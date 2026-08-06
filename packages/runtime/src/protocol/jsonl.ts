export const DEFAULT_JSONL_MAX_FRAME_BYTES = 1024 * 1024;

export interface JsonlDecoderOptions {
  readonly maxFrameBytes?: number;
}

export type JsonlDecodeResult =
  | { readonly value: unknown }
  | { readonly error: JsonlFrameError };

export class JsonlFrameError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JsonlFrameError";
  }
}

/** Incrementally frames bounded UTF-8 JSON Lines. Empty lines are ignored. */
export class JsonlDecoder {
  #buffer: Uint8Array;
  #length = 0;
  #discardingOversizedFrame = false;
  readonly #maxFrameBytes: number;
  readonly #textDecoder = new TextDecoder("utf-8", { fatal: true });
  readonly #textEncoder = new TextEncoder();
  #trailingHighSurrogate = "";

  constructor({
    maxFrameBytes = DEFAULT_JSONL_MAX_FRAME_BYTES,
  }: JsonlDecoderOptions = {}) {
    if (!(Number.isSafeInteger(maxFrameBytes) && maxFrameBytes > 0)) {
      throw new RangeError("maxFrameBytes must be a positive safe integer");
    }
    this.#maxFrameBytes = maxFrameBytes;
    this.#buffer = new Uint8Array(Math.min(1024, maxFrameBytes + 1));
  }

  push(chunk: string | Uint8Array): unknown[] {
    return valuesOrThrow(this.pushResults(chunk));
  }

  pushResults(chunk: string | Uint8Array): JsonlDecodeResult[] {
    const results: JsonlDecodeResult[] = [];
    if (typeof chunk === "string") {
      let text = `${this.#trailingHighSurrogate}${chunk}`;
      this.#trailingHighSurrogate = "";
      if (hasTrailingHighSurrogate(text)) {
        this.#trailingHighSurrogate = text.at(-1) ?? "";
        text = text.slice(0, -1);
      }
      results.push(...this.#pushBytes(this.#textEncoder.encode(text)));
      return results;
    }
    if (this.#trailingHighSurrogate) {
      results.push(
        ...this.#pushBytes(
          this.#textEncoder.encode(this.#trailingHighSurrogate)
        )
      );
      this.#trailingHighSurrogate = "";
    }
    results.push(...this.#pushBytes(chunk));
    return results;
  }

  finish(): unknown[] {
    return valuesOrThrow(this.finishResults());
  }

  finishResults(): JsonlDecodeResult[] {
    const results: JsonlDecodeResult[] = [];
    if (this.#trailingHighSurrogate) {
      results.push(
        ...this.#pushBytes(
          this.#textEncoder.encode(this.#trailingHighSurrogate)
        )
      );
      this.#trailingHighSurrogate = "";
    }
    if (this.#discardingOversizedFrame) {
      this.#discardingOversizedFrame = false;
      this.#length = 0;
      return results;
    }
    if (this.#length === 0) {
      return results;
    }
    const parsed = this.#parseBufferedFrame();
    this.#length = 0;
    if (parsed !== undefined) {
      results.push(parsed);
    }
    return results;
  }

  #pushBytes(bytes: Uint8Array): JsonlDecodeResult[] {
    const results: JsonlDecodeResult[] = [];
    let cursor = 0;
    while (cursor < bytes.byteLength) {
      const newline = bytes.indexOf(10, cursor);
      const end = newline < 0 ? bytes.byteLength : newline;
      if (!this.#discardingOversizedFrame) {
        const error = this.#append(bytes.subarray(cursor, end));
        if (error) {
          results.push({ error });
        }
      }
      if (newline < 0) {
        return results;
      }
      if (this.#discardingOversizedFrame) {
        this.#discardingOversizedFrame = false;
        this.#length = 0;
      } else {
        const parsed = this.#parseBufferedFrame();
        if (parsed !== undefined) {
          results.push(parsed);
        }
        this.#length = 0;
      }
      cursor = newline + 1;
    }
    return results;
  }

  #append(bytes: Uint8Array): JsonlFrameError | undefined {
    const maximumBufferedBytes = this.#maxFrameBytes + 1;
    const available = maximumBufferedBytes - this.#length;
    const copied = Math.min(available, bytes.byteLength);
    this.#ensureCapacity(this.#length + copied);
    this.#buffer.set(bytes.subarray(0, copied), this.#length);
    this.#length += copied;
    const exceedsLimit =
      bytes.byteLength > copied ||
      payloadByteLength(this.#buffer.subarray(0, this.#length)) >
        this.#maxFrameBytes;
    if (!exceedsLimit) {
      return;
    }
    this.#length = 0;
    this.#discardingOversizedFrame = true;
    return this.#oversizedError();
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#buffer.byteLength) {
      return;
    }
    const capacity = Math.min(
      this.#maxFrameBytes + 1,
      Math.max(required, this.#buffer.byteLength * 2)
    );
    const grown = new Uint8Array(capacity);
    grown.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = grown;
  }

  #parseBufferedFrame(): JsonlDecodeResult | undefined {
    const frame = this.#buffer.subarray(0, this.#length);
    if (payloadByteLength(frame) > this.#maxFrameBytes) {
      return { error: this.#oversizedError() };
    }
    try {
      const decoded = this.#textDecoder.decode(frame);
      const line = decoded.endsWith("\r") ? decoded.slice(0, -1) : decoded;
      if (line.trim() === "") {
        return;
      }
      return { value: JSON.parse(line) };
    } catch (cause) {
      return { error: new JsonlFrameError("Invalid JSONL frame", { cause }) };
    }
  }

  #oversizedError(): JsonlFrameError {
    return new JsonlFrameError(
      `JSONL frame exceeds ${this.#maxFrameBytes} bytes`
    );
  }
}

export function encodeJsonl(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") {
      return item.toString();
    }
    if (
      item === undefined ||
      typeof item === "function" ||
      typeof item === "symbol" ||
      (typeof item === "number" && !Number.isFinite(item))
    ) {
      throw new JsonlFrameError("Value is not representable as JSON");
    }
    return item;
  });
  if (encoded === undefined) {
    throw new JsonlFrameError("Value is not representable as JSON");
  }
  return `${encoded}\n`;
}

function hasTrailingHighSurrogate(value: string): boolean {
  const codeUnit = value.charCodeAt(value.length - 1);
  return codeUnit >= 0xd8_00 && codeUnit <= 0xdb_ff;
}

function payloadByteLength(frame: Uint8Array): number {
  return frame.byteLength - (frame.at(-1) === 13 ? 1 : 0);
}

function valuesOrThrow(results: readonly JsonlDecodeResult[]): unknown[] {
  const values: unknown[] = [];
  for (const result of results) {
    if ("error" in result) {
      throw result.error;
    }
    values.push(result.value);
  }
  return values;
}
