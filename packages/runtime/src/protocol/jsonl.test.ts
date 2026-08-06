import { describe, expect, it } from "vitest";
import { encodeJsonl, JsonlDecoder } from "./jsonl";

describe("JSONL framing", () => {
  it("frames split UTF-8 chunks and multiple records", () => {
    const bytes = new TextEncoder().encode(
      `${encodeJsonl({ text: "안녕" })}${encodeJsonl({ ok: true })}`
    );
    const decoder = new JsonlDecoder();
    expect(decoder.push(bytes.slice(0, 8))).toEqual([]);
    expect(decoder.push(bytes.slice(8))).toEqual([
      { text: "안녕" },
      { ok: true },
    ]);
    expect(decoder.finish()).toEqual([]);
  });

  it("accepts a final unterminated record and CRLF", () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push('{"a":1}\r\n{"b":')).toEqual([{ a: 1 }]);
    expect(decoder.push("2}")).toEqual([]);
    expect(decoder.finish()).toEqual([{ b: 2 }]);
  });

  it("rejects malformed records", () => {
    expect(() => new JsonlDecoder().push("nope\n")).toThrow();
  });
});
