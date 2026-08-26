import {
  normalizeTurnError,
  type TurnErrorMetadataV1,
} from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { createTuiErrorPresentation } from "./error-presentation";

const NUMERIC_PROPERTY = /^\d+$/;

describe("createTuiErrorPresentation", () => {
  it("keeps arbitrary Error prose generic", () => {
    // Given
    const error = new Error("RAW_PROVIDER_SECRET");

    // When
    const result = createTuiErrorPresentation(error);

    // Then
    expect(result.message).toBe(normalizeTurnError(error).message);
    expect(JSON.stringify(result)).not.toContain("RAW_PROVIDER_SECRET");
  });

  it("keeps arbitrary string prose generic", () => {
    // Given
    const error: unknown = "RAW_STRING_SECRET\u001b[2J";

    // When
    const result = createTuiErrorPresentation(error);

    // Then
    expect(result.message).toBe(normalizeTurnError(error).message);
    expect(JSON.stringify(result)).not.toContain("RAW_STRING_SECRET");
    expect(result.message).not.toContain("\u001b");
  });

  it("fails closed when a presentation message getter throws", () => {
    // Given
    const presentation = Object.defineProperty(
      { title: "Internal title" },
      "message",
      {
        get() {
          throw new Error("MESSAGE_GETTER_SECRET");
        },
      }
    );

    // When
    const result = createTuiErrorPresentation(presentation);

    // Then
    expect(JSON.stringify(result)).not.toContain("MESSAGE_GETTER_SECRET");
  });

  it("fails closed when a presentation title getter throws", () => {
    // Given
    const presentation = Object.defineProperty(
      { message: "Internal message" },
      "title",
      {
        get() {
          throw new Error("TITLE_GETTER_SECRET");
        },
      }
    );

    // When
    const result = createTuiErrorPresentation(presentation);

    // Then
    expect(JSON.stringify(result)).not.toContain("TITLE_GETTER_SECRET");
  });

  it("does not return a hostile correlation getter", () => {
    // Given
    const presentation = new Proxy(
      { message: "Internal message", title: "Internal title" },
      {
        get(target, property, receiver) {
          if (property === "correlationIds") {
            throw new Error("CORRELATION_GETTER_SECRET");
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );

    // When
    const result = createTuiErrorPresentation(presentation);

    // Then
    expect(result.correlationIds).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("CORRELATION_GETTER_SECRET");
  });

  it.each([200_000, 2 ** 32 - 1])(
    "examines bounded indexes when correlation IDs have sparse length %s",
    (length) => {
      // Given
      let numericReads = 0;
      const correlationIds = new Proxy(new Array(length), {
        get(target, property, receiver) {
          if (typeof property === "string" && NUMERIC_PROPERTY.test(property)) {
            numericReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      });

      // When
      const result = createTuiErrorPresentation({
        correlationIds,
        message: "safe",
        title: "safe",
      });

      // Then
      expect(numericReads).toBeLessThanOrEqual(256);
      expect(result.correlationIds).toBeUndefined();
    }
  );

  it("caps emitted correlation IDs from a dense array", () => {
    // Given
    let numericReads = 0;
    const correlationIds = new Proxy(
      Array.from({ length: 300 }, (_, index) => ({
        source: "request",
        value: `id-${index}`,
      })),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && NUMERIC_PROPERTY.test(property)) {
            numericReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );

    // When
    const result = createTuiErrorPresentation({
      correlationIds,
      message: "safe",
      title: "safe",
    });

    // Then
    expect(result.correlationIds).toHaveLength(32);
    expect(numericReads).toBeLessThanOrEqual(256);
  });

  it("fails closed when a correlation item getter throws", () => {
    // Given
    const hostileItem = Object.defineProperty({}, "source", {
      get() {
        throw new Error("hostile source");
      },
    });

    // When
    const result = createTuiErrorPresentation({
      correlationIds: [hostileItem],
      message: "safe",
      title: "safe",
    });

    // Then
    expect(result.correlationIds).toBeUndefined();
  });

  it("fails closed when correlation array length access throws", () => {
    // Given
    const correlationIds = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("hostile length");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    // When
    const result = createTuiErrorPresentation({
      correlationIds,
      message: "safe",
      title: "safe",
    });

    // Then
    expect(result.correlationIds).toBeUndefined();
  });

  it("fails closed when correlation index access throws", () => {
    // Given
    const correlationIds = new Proxy([{}], {
      get(target, property, receiver) {
        if (property === "0") {
          throw new Error("hostile index");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    // When
    const result = createTuiErrorPresentation({
      correlationIds,
      message: "safe",
      title: "safe",
    });

    // Then
    expect(result.correlationIds).toBeUndefined();
  });

  it("deduplicates sanitized IDs while skipping malformed and repeated prose", () => {
    // Given
    const correlationIds = [
      { source: "request", value: "id-1" },
      { source: "request", value: "id-1" },
      { source: "request\u2066-source", value: "id\u001b[2J-2" },
      { source: "message", value: "safe" },
      null,
      { source: 42, value: "malformed" },
      { source: "", value: "empty-source" },
    ];

    // When
    const result = createTuiErrorPresentation({
      correlationIds,
      message: "safe message",
      title: "safe title",
    });

    // Then
    expect(result.correlationIds).toEqual([
      { source: "request", value: "id-1" },
      { source: "request-source", value: "id^[[2J-2" },
    ]);
  });

  it("fails closed when metadata property access throws", () => {
    // Given
    const metadata: TurnErrorMetadataV1 = new Proxy(
      { category: "unknown", version: 1 },
      {
        get() {
          throw new Error("METADATA_GETTER_SECRET");
        },
      }
    );

    // When
    const result = createTuiErrorPresentation("Safe runtime failure", metadata);

    // Then
    expect(JSON.stringify(result)).not.toContain("METADATA_GETTER_SECRET");
  });

  it("removes terminal-active Unicode from every presentation field", () => {
    // Given
    const presentation = {
      correlationIds: [
        {
          source: "request\u2066-source",
          value: "value\u{e0001}-id",
        },
      ],
      hint: "retry\u0085later",
      message: "provider\u2028failure",
      title: "unsafe\u202etitle",
    };

    // When
    const result = createTuiErrorPresentation(presentation);

    // Then
    expect(result).toEqual({
      correlationIds: [{ source: "request-source", value: "value-id" }],
      hint: "retry\\u0085later",
      message: "providerfailure",
      title: "unsafetitle",
    });
  });

  it("sanitizes and bounds internal presentation fields", () => {
    // Given
    const presentation = {
      correlationIds: [
        {
          source: `${"s".repeat(256)}\u001b[2J`,
          value: `${"v".repeat(512)}\u009b2J`,
        },
      ],
      hint: `${"h".repeat(1024)}\u001b[2J`,
      message: `${"m".repeat(8192)}\u001b[2J`,
      title: `${"t".repeat(256)}\u009b2J`,
    };

    // When
    const result = createTuiErrorPresentation(presentation);

    // Then
    expect(result.message.length).toBeLessThanOrEqual(4096);
    expect(result.title.length).toBeLessThanOrEqual(128);
    expect(result.hint?.length).toBeLessThanOrEqual(512);
    expect(result.correlationIds?.[0]?.source.length).toBeLessThanOrEqual(128);
    expect(result.correlationIds?.[0]?.value.length).toBeLessThanOrEqual(256);
    const terminalText = [
      result.message,
      result.title,
      result.hint ?? "",
      ...(result.correlationIds ?? []).flatMap(({ source, value }) => [
        source,
        value,
      ]),
    ].join("");
    expect(terminalText).not.toContain("\u001b");
    expect(terminalText).not.toContain("\u009b");
  });
});
