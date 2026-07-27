import { APICallError, RetryError } from "ai";
import type {
  TurnErrorCategory,
  TurnErrorCorrelationId,
  TurnErrorMetadataV1,
} from "../protocol/events";

const CORRELATION_HEADER = /^x-[a-z0-9-]+-(?:correlation|request|trace)-id$/;
const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
]);
const TIMEOUT_ERROR_CODES = new Set([
  "ABORT_ERR",
  "ECONNABORTED",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

interface ProviderErrorFields {
  readonly code?: string;
  readonly providerType?: string;
}

interface TransportErrorFields {
  readonly category: "cancelled" | "network" | "timeout";
  readonly code?: string;
}

export interface NormalizedTurnError {
  readonly error?: TurnErrorMetadataV1;
  readonly message?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const boundedMetadataString = (
  value: unknown,
  maxLength = 256
): string | undefined => {
  if (typeof value !== "string") {
    return;
  }
  const sanitized = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        codePoint >= 32 &&
        (codePoint < 127 || codePoint > 159)
      );
    })
    .join("")
    .trim();
  if (sanitized.length === 0) {
    return;
  }
  return sanitized.slice(0, maxLength);
};

const findApiCallError = (
  error: unknown,
  seen = new Set<unknown>()
): APICallError | undefined => {
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return;
  }
  seen.add(error);

  if (APICallError.isInstance(error)) {
    return error;
  }
  if (RetryError.isInstance(error)) {
    const retryCandidates = [
      error.lastError,
      ...[...error.errors].reverse(),
      error.cause,
    ];
    for (const candidate of retryCandidates) {
      const apiError = findApiCallError(candidate, seen);
      if (apiError !== undefined) {
        return apiError;
      }
    }
    return;
  }

  if (error instanceof AggregateError) {
    for (const candidate of [...error.errors].reverse()) {
      const apiError = findApiCallError(candidate, seen);
      if (apiError !== undefined) {
        return apiError;
      }
    }
  }

  return findApiCallError(Reflect.get(error, "cause"), seen);
};

const readProviderErrorFields = (data: unknown): ProviderErrorFields => {
  if (!isRecord(data)) {
    return {};
  }
  const providerError = isRecord(data.error) ? data.error : data;
  return {
    ...(boundedMetadataString(providerError.code, 128) === undefined
      ? {}
      : { code: boundedMetadataString(providerError.code, 128) }),
    ...(boundedMetadataString(providerError.type, 128) === undefined
      ? {}
      : { providerType: boundedMetadataString(providerError.type, 128) }),
  };
};

const categoryFromStatus = (status: number | undefined): TurnErrorCategory => {
  if (status === 401) {
    return "authentication";
  }
  if (status === 402) {
    return "quota";
  }
  if (status === 403) {
    return "permission";
  }
  if (status === 408) {
    return "timeout";
  }
  if (status === 429) {
    return "rate-limit";
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return "bad-request";
  }
  return "upstream";
};

const safeMessageForCategory = (category: TurnErrorCategory): string => {
  switch (category) {
    case "authentication":
      return "Provider authentication failed.";
    case "bad-request":
      return "The provider rejected this request.";
    case "cancelled":
      return "The request was cancelled.";
    case "context-overflow":
      return "The request exceeded the context limit.";
    case "network":
      return "Could not reach the provider.";
    case "permission":
      return "The provider refused this request.";
    case "quota":
      return "Provider quota is unavailable.";
    case "rate-limit":
      return "The provider rate limit was reached.";
    case "stream":
      return "The provider response stream failed.";
    case "timeout":
      return "The provider request timed out.";
    case "upstream":
      return "The provider failed to complete the request.";
    default:
      return "The request failed.";
  }
};

const headerEntries = (
  headers: Record<string, string> | undefined
): readonly [string, string][] =>
  Object.entries(headers ?? {}).map(([name, value]) => [
    name.toLowerCase(),
    value,
  ]);

const isCorrelationHeader = (name: string): boolean =>
  name === "cf-ray" ||
  name === "request-id" ||
  name === "x-amzn-requestid" ||
  name === "x-request-id" ||
  CORRELATION_HEADER.test(name);

const correlationIdsFromHeaders = (
  headers: Record<string, string> | undefined
): readonly TurnErrorCorrelationId[] => {
  const correlationIds = headerEntries(headers)
    .filter(([name]) => isCorrelationHeader(name))
    .flatMap(([source, rawValue]) => {
      const value = boundedMetadataString(rawValue);
      return value === undefined ? [] : [{ source, value }];
    });
  correlationIds.sort((left, right) => left.source.localeCompare(right.source));
  return correlationIds;
};

const retryAfterMsFromHeaders = (
  headers: Record<string, string> | undefined
): number | undefined => {
  const normalizedHeaders = new Map(headerEntries(headers));
  const retryAfterMs = Number(normalizedHeaders.get("retry-after-ms"));
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.round(retryAfterMs);
  }

  const retryAfter = normalizedHeaders.get("retry-after");
  if (retryAfter === undefined) {
    return;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const retryAt = Date.parse(retryAfter);
  return Number.isNaN(retryAt) ? undefined : Math.max(0, retryAt - Date.now());
};

const normalizeApiCallError = (error: APICallError): TurnErrorMetadataV1 => {
  const providerFields = readProviderErrorFields(error.data);
  const correlationIds = correlationIdsFromHeaders(error.responseHeaders);
  const retryAfterMs = retryAfterMsFromHeaders(error.responseHeaders);
  return {
    category: categoryFromStatus(error.statusCode),
    ...providerFields,
    ...(correlationIds.length === 0 ? {} : { correlationIds }),
    observedRetryable: error.isRetryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(error.statusCode === undefined ? {} : { status: error.statusCode }),
    version: 1,
  };
};

const findNamedErrorField = (
  error: unknown,
  field: "code" | "name",
  seen = new Set<unknown>()
): string | undefined => {
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return;
  }
  seen.add(error);
  const fieldValue = boundedMetadataString(Reflect.get(error, field), 128);
  return (
    fieldValue ?? findNamedErrorField(Reflect.get(error, "cause"), field, seen)
  );
};

const classifyTransportError = (
  error: unknown
): TransportErrorFields | undefined => {
  const errorName = findNamedErrorField(error, "name");
  if (errorName === "AbortError") {
    return { category: "cancelled" };
  }
  if (errorName === "TimeoutError") {
    return { category: "timeout" };
  }

  const errorCode = findNamedErrorField(error, "code");
  if (errorCode !== undefined && TIMEOUT_ERROR_CODES.has(errorCode)) {
    return { category: "timeout", code: errorCode };
  }
  if (errorCode !== undefined && NETWORK_ERROR_CODES.has(errorCode)) {
    return { category: "network", code: errorCode };
  }
  return;
};

export const normalizeTurnError = (error: unknown): NormalizedTurnError => {
  const apiError = findApiCallError(error);
  if (apiError !== undefined) {
    const transport =
      apiError.statusCode === undefined
        ? classifyTransportError(apiError.cause)
        : undefined;
    const normalized = normalizeApiCallError(apiError);
    const errorMetadata =
      transport === undefined
        ? normalized
        : {
            ...normalized,
            category: transport.category,
            ...(normalized.code === undefined && transport.code !== undefined
              ? { code: transport.code }
              : {}),
          };
    return {
      error: errorMetadata,
      message: safeMessageForCategory(errorMetadata.category),
    };
  }

  const transport = classifyTransportError(error);
  if (transport !== undefined) {
    return {
      error: { ...transport, version: 1 },
      message: safeMessageForCategory(transport.category),
    };
  }
  const errorCode = findNamedErrorField(error, "code");
  return {
    error: {
      category: "unknown",
      ...(errorCode === undefined ? {} : { code: errorCode }),
      version: 1,
    },
  };
};
