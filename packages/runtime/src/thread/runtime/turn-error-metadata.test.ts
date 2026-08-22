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

describe("normalizeTurnError", () => {
  it("classifies statusless API call network failures from their cause", () => {
    expect(normalizeTurnError(apiFailureWithCause("ENOTFOUND"))).toEqual({
      error: {
        category: "network",
        code: "ENOTFOUND",
        observedRetryable: true,
        version: 1,
      },
      message: "Could not reach the provider.",
    });
  });

  it("classifies statusless API call timeouts through retry wrappers", () => {
    const timeout = apiFailureWithCause("ETIMEDOUT");
    const retryError = new RetryError({
      errors: [new Error("first failure"), timeout],
      message: "Failed after 2 attempts",
      reason: "maxRetriesExceeded",
    });

    expect(normalizeTurnError(retryError)).toEqual({
      error: {
        category: "timeout",
        code: "ETIMEDOUT",
        observedRetryable: true,
        version: 1,
      },
      message: "The provider request timed out.",
    });
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

    expect(normalized.message).toBe("The provider refused this request.");
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

  it("bounds retained correlation metadata", () => {
    const responseHeaders = Object.fromEntries([
      ...Array.from({ length: 12 }, (_, index) => [
        `x-provider-${index}-request-id`,
        `request-${index}`,
      ]),
      [`x-${"a".repeat(80)}-request-id`, "oversized-source"],
    ]);
    const providerError = new APICallError({
      isRetryable: true,
      message: "provider failure",
      requestBodyValues: {},
      responseHeaders,
      statusCode: 500,
      url: "https://provider.example/v1/chat/completions",
    });

    const correlationIds =
      normalizeTurnError(providerError).error?.correlationIds;

    expect(correlationIds).toHaveLength(8);
    expect(correlationIds).toSatisfy(
      (
        entries: readonly { readonly source: string; readonly value: string }[]
      ) =>
        entries.every(
          ({ source, value }) => source.length <= 64 && value.length <= 256
        )
    );
    expect(JSON.stringify(correlationIds)).not.toContain("oversized-source");
  });
});
