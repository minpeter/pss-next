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
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #discardingOversizedFrame = false;
  readonly #maxFrameBytes: number;
  readonly #textDecoder = new TextDecoder("utf-8", { fatal: true });
  readonly #textEncoder = new TextEncoder();

  constructor({
    maxFrameBytes = DEFAULT_JSONL_MAX_FRAME_BYTES,
  }: JsonlDecoderOptions = {}) {
    if (!(Number.isSafeInteger(maxFrameBytes) && maxFrameBytes > 0)) {
      throw new RangeError("maxFrameBytes must be a positive safe integer");
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: string | Uint8Array): unknown[] {
    return valuesOrThrow(this.pushResults(chunk));
  }

  pushResults(chunk: string | Uint8Array): JsonlDecodeResult[] {
    const bytes =
      typeof chunk === "string" ? this.#textEncoder.encode(chunk) : chunk;
    this.#buffer = concatenate(this.#buffer, bytes);
    return this.#drain(false);
  }

  finish(): unknown[] {
    return valuesOrThrow(this.finishResults());
  }

  finishResults(): JsonlDecodeResult[] {
    return this.#drain(true);
  }

  #drain(finish: boolean): JsonlDecodeResult[] {
    const results: JsonlDecodeResult[] = [];
    while (true) {
      const newline = this.#buffer.indexOf(10);
      if (this.#discardingOversizedFrame) {
        if (!this.#finishDiscard(newline)) {
          return results;
        }
        continue;
      }
      if (newline < 0 && !finish) {
        this.#checkIncompleteFrame(results);
        return results;
      }
      if (newline < 0 && this.#buffer.byteLength === 0) {
        return results;
      }
      const frame = this.#takeFrame(newline);
      const parsed = this.#decodeFrame(frame);
      if (parsed !== undefined) {
        results.push(parsed);
      }
      if (newline < 0) {
        return results;
      }
    }
  }

  #finishDiscard(newline: number): boolean {
    if (newline < 0) {
      this.#buffer = new Uint8Array();
      return false;
    }
    this.#buffer = this.#buffer.slice(newline + 1);
    this.#discardingOversizedFrame = false;
    return true;
  }

  #checkIncompleteFrame(results: JsonlDecodeResult[]): void {
    if (this.#buffer.byteLength <= this.#maxFrameBytes) {
      return;
    }
    results.push({ error: this.#oversizedError() });
    this.#buffer = new Uint8Array();
    this.#discardingOversizedFrame = true;
  }

  #takeFrame(newline: number): Uint8Array<ArrayBufferLike> {
    const end = newline < 0 ? this.#buffer.byteLength : newline;
    const frame = this.#buffer.slice(0, end);
    this.#buffer =
      newline < 0 ? new Uint8Array() : this.#buffer.slice(newline + 1);
    return frame;
  }

  #decodeFrame(frame: Uint8Array): JsonlDecodeResult | undefined {
    if (frame.byteLength > this.#maxFrameBytes) {
      return { error: this.#oversizedError() };
    }
    return this.#parse(frame);
  }

  #parse(frame: Uint8Array): JsonlDecodeResult | undefined {
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
  return `${JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item
  )}\n`;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) {
    return right.slice();
  }
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
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
