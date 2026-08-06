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

  it("keeps decoder UTF-8 state isolated when instances interleave", () => {
    const first = new JsonlDecoder();
    const second = new JsonlDecoder();
    const one = new TextEncoder().encode('{"text":"한"}\n');
    const two = new TextEncoder().encode('{"text":"글"}\n');
    expect(first.push(one.slice(0, 10))).toEqual([]);
    expect(second.push(two.slice(0, 10))).toEqual([]);
    expect(first.push(one.slice(10))).toEqual([{ text: "한" }]);
    expect(second.push(two.slice(10))).toEqual([{ text: "글" }]);
  });

  it("bounds frames by UTF-8 bytes across chunks and recovers at newline", () => {
    const decoder = new JsonlDecoder({ maxFrameBytes: 8 });
    expect(decoder.pushResults('{"x":"')).toEqual([]);
    const oversized = decoder.pushResults("한");
    expect(oversized).toHaveLength(1);
    expect(oversized[0]).toHaveProperty("error");
    expect(decoder.pushResults('"}\n{"x":1}\n')).toEqual([{ value: { x: 1 } }]);
  });

  it("isolates malformed records from valid neighbors", () => {
    const decoder = new JsonlDecoder();
    const results = decoder.pushResults('{"before":1}\nnope\n{"after":2}\n');
    expect(results[0]).toEqual({ value: { before: 1 } });
    expect(results[1]).toHaveProperty("error");
    expect(results[2]).toEqual({ value: { after: 2 } });
  });

  it("excludes an optional CR from the frame byte limit across CRLF chunks", () => {
    const exact = new JsonlDecoder({ maxFrameBytes: 7 });
    expect(exact.pushResults('{"x":1}\r')).toEqual([]);
    expect(exact.pushResults("\n")).toEqual([{ value: { x: 1 } }]);

    const oversized = new JsonlDecoder({ maxFrameBytes: 6 });
    expect(oversized.pushResults('{"x":1}\r')).toHaveLength(1);
    expect(oversized.pushResults("\n")).toEqual([]);
  });

  it("rejects non-JSON encoder values and invalid UTF-8", () => {
    expect(() => encodeJsonl(undefined)).toThrow("not representable");
    expect(() => encodeJsonl({ missing: undefined })).toThrow(
      "not representable"
    );
    expect(() => encodeJsonl(Number.NaN)).toThrow("not representable");
    expect(() => new JsonlDecoder().push(new Uint8Array([0xff, 0x0a]))).toThrow(
      "Invalid JSONL frame"
    );
  });

  it("assembles a large frame from tiny chunks", () => {
    const payload = "x".repeat(64 * 1024);
    const encoded = encodeJsonl({ payload });
    const decoder = new JsonlDecoder({ maxFrameBytes: encoded.length });
    const values: unknown[] = [];
    for (const character of encoded) {
      values.push(...decoder.push(character));
    }
    expect(values).toEqual([{ payload }]);
  });

  it("preserves a surrogate pair split across string chunks", () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push('{"emoji":"\ud83d')).toEqual([]);
    expect(decoder.push('\ude00"}\n')).toEqual([{ emoji: "😀" }]);
  });
});
