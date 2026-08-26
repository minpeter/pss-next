import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { normalizeTurnError } from "./turn-error-metadata";

const apiFailureWithCause = (
  code: string,
  message = "provider leaked secret-token"
): APICallError =>
  new APICallError({
    cause: Object.assign(new Error("transport failure"), { code }),
    isRetryable: true,
    message,
    requestBodyValues: { apiKey: "request-secret" },
    url: "https://provider.example/v1/chat/completions?token=url-secret",
  });

const apiFailureWithStatus = (statusCode: number): APICallError =>
  new APICallError({
    isRetryable: false,
    message: "provider failure",
    requestBodyValues: {},
    statusCode,
    url: "https://provider.example/v1/chat/completions",
  });

const SAFE_UNKNOWN_ERROR = { category: "unknown", version: 1 } as const;

describe("normalizeTurnError", () => {
  it("classifies statusless API call network failures from their cause", () => {
    expect(normalizeTurnError(apiFailureWithCause("ENOTFOUND")).error).toEqual({
      category: "network",
      code: "ENOTFOUND",
      observedRetryable: true,
      version: 1,
    });
  });

  it("classifies statusless API call timeouts through retry wrappers", () => {
    const timeout = apiFailureWithCause("ETIMEDOUT");
    const retryError = new RetryError({
      errors: [new Error("first failure"), timeout],
      message: "Failed after 2 attempts",
      reason: "maxRetriesExceeded",
    });

    expect(normalizeTurnError(retryError).error).toEqual({
      category: "timeout",
      code: "ETIMEDOUT",
      observedRetryable: true,
      version: 1,
    });
  });

  it("preserves newest-first API error selection in aggregate errors", () => {
    const aggregateError = new AggregateError(
      [apiFailureWithStatus(401), apiFailureWithStatus(403)],
      "provider attempts failed"
    );

    expect(normalizeTurnError(aggregateError).error).toEqual({
      category: "permission",
      observedRetryable: false,
      status: 403,
      version: 1,
    });
  });

  it("terminates cause traversal when an error contains a cycle", () => {
    const cyclicError: { cause?: unknown } = {};
    cyclicError.cause = cyclicError;

    expect(normalizeTurnError(cyclicError).error).toEqual(SAFE_UNKNOWN_ERROR);
  });

  it("removes provider prose and control characters from durable output", () => {
    const providerError = new APICallError({
      data: {
        error: {
          code: "permission\u009b2J",
          type: "provider\u001b[2J",
        },
      },
      isRetryable: false,
      message: "Bearer secret-token request-secret url-secret",
      requestBodyValues: { apiKey: "request-secret" },
      responseHeaders: {
        "x-request-id": "request\u009b2J",
      },
      statusCode: 403,
      url: "https://provider.example/v1/chat/completions?token=url-secret",
    });

    const normalized = normalizeTurnError(providerError);
    const serialized = JSON.stringify(normalized);

    expect(normalized.error).toMatchObject({
      category: "permission",
      observedRetryable: false,
      status: 403,
      version: 1,
    });
    for (const forbidden of [
      "secret-token",
      "request-secret",
      "url-secret",
      "\u001b",
      "\u009b",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("omits provider correlation metadata", () => {
    const providerError = new APICallError({
      isRetryable: true,
      message: "provider failure",
      requestBodyValues: {},
      responseHeaders: {
        "x-request-id": "provider-correlation-secret",
      },
      statusCode: 500,
      url: "https://provider.example/v1/chat/completions",
    });

    expect(
      normalizeTurnError(providerError).error?.correlationIds
    ).toBeUndefined();
  });

  it("rejects a control-character header name that sanitizes to a trusted source", () => {
    const providerError = new APICallError({
      isRetryable: true,
      message: "provider failure",
      requestBodyValues: {},
      responseHeaders: {
        "x-request-\0id": "spoofed-request-id",
      },
      statusCode: 500,
      url: "https://provider.example/v1/chat/completions",
    });

    expect(
      normalizeTurnError(providerError).error?.correlationIds
    ).toBeUndefined();
  });

  it("returns safe unknown metadata when cause nesting exceeds the traversal bound", () => {
    let deeplyNestedError: unknown = new Error("root failure");
    for (let depth = 0; depth < 150_000; depth += 1) {
      deeplyNestedError = { cause: deeplyNestedError };
    }

    expect(normalizeTurnError(deeplyNestedError).error).toEqual(
      SAFE_UNKNOWN_ERROR
    );
  });

  it.each(["cause", "name", "code"] as const)(
    "returns safe unknown metadata when the %s accessor throws",
    (field) => {
      const hostileError = Object.defineProperty({}, field, {
        get() {
          throw new Error(`hostile ${field} accessor`);
        },
      });

      expect(normalizeTurnError(hostileError).error).toEqual(
        SAFE_UNKNOWN_ERROR
      );
    }
  );

  it("returns safe unknown metadata when an API cause accessor throws", () => {
    const providerError = apiFailureWithCause("ENOTFOUND");
    Object.defineProperty(providerError, "cause", {
      get() {
        throw new Error("hostile API cause accessor");
      },
    });

    expect(normalizeTurnError(providerError).error).toEqual(SAFE_UNKNOWN_ERROR);
  });

  it("bounds lazy aggregate error consumption by the traversal budget", () => {
    let yieldCount = 0;
    const aggregateError = new AggregateError([], "provider attempts failed");
    Object.defineProperty(aggregateError, "errors", {
      value: (function* lazyErrors() {
        for (let index = 0; index < 150_000; index += 1) {
          yieldCount += 1;
          yield new Error(`failure ${index}`);
        }
      })(),
    });

    expect(normalizeTurnError(aggregateError).error).toEqual(
      SAFE_UNKNOWN_ERROR
    );
    expect(yieldCount).toBeLessThanOrEqual(9999);
  });

  it("rejects an overlong raw source before bounding retained metadata", () => {
    const validLengthPrefix = `x-${"a".repeat(51)}-request-id`;
    expect(validLengthPrefix).toHaveLength(64);
    const providerError = new APICallError({
      isRetryable: true,
      message: "provider failure",
      requestBodyValues: {},
      responseHeaders: {
        [`${validLengthPrefix}-spoofed`]: "must-not-be-retained",
        "x-request-id": "v".repeat(300),
      },
      statusCode: 500,
      url: "https://provider.example/v1/chat/completions",
    });

    expect(
      normalizeTurnError(providerError).error?.correlationIds
    ).toBeUndefined();
  });
});
