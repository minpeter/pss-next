const decoder = new TextDecoder();

/** Incrementally frames UTF-8 JSON Lines. Empty lines are ignored. */
export class JsonlDecoder {
  #buffer = "";

  push(chunk: string | Uint8Array): unknown[] {
    this.#buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines.flatMap((line) => parseLine(line));
  }

  finish(): unknown[] {
    this.#buffer += decoder.decode();
    const final = this.#buffer;
    this.#buffer = "";
    return parseLine(final);
  }
}

export function encodeJsonl(value: unknown): string {
  return `${JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item
  )}\n`;
}

function parseLine(line: string): unknown[] {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (trimmed.trim() === "") {
    return [];
  }
  return [JSON.parse(trimmed)];
}
