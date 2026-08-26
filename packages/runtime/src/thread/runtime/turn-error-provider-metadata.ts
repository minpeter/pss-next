import type { APICallError } from "ai";
import type {
  TurnErrorCategory,
  TurnErrorMetadataV1,
} from "../protocol/events";

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
const MAX_RETRY_AFTER_LENGTH = 128;
const MAX_RETRY_AFTER_MS = 86_400_000;
const INTEGER_PATTERN = /^\d+$/u;
const NUMERIC_PATTERN = /^\d+(?:\.\d+)?$/u;
const TERMINAL_ACTIVE_UNICODE_PATTERN = /\p{Cf}|\p{Zl}|\p{Zp}/u;
const SAFE_MESSAGES = {
  authentication: "Provider authentication failed.",
  "bad-request": "The provider rejected this request.",
  cancelled: "The request was cancelled.",
  "context-overflow": "The request exceeded the context limit.",
  network: "Could not reach the provider.",
  permission: "The provider refused this request.",
  quota: "Provider quota is unavailable.",
  "rate-limit": "The provider rate limit was reached.",
  stream: "The provider response stream failed.",
  timeout: "The provider request timed out.",
  unknown: "The request failed.",
  upstream: "The provider failed to complete the request.",
} as const satisfies Readonly<Record<TurnErrorCategory, string>>;

export const PROVIDER_METADATA_FAILED = Symbol("provider-metadata-failed");

export interface TransportErrorFields {
  readonly category: "cancelled" | "network" | "timeout";
  readonly code?: string;
}

type ProviderMetadataResult =
  | TurnErrorMetadataV1
  | typeof PROVIDER_METADATA_FAILED;
type RetryAfterResult = number | undefined | typeof PROVIDER_METADATA_FAILED;

const safeRead = <T>(read: () => T): T | typeof PROVIDER_METADATA_FAILED => {
  try {
    return read();
  } catch {
    return PROVIDER_METADATA_FAILED;
  }
};

export const boundedMetadataString = (
  value: unknown,
  maxLength = 256
): string | undefined => {
  if (typeof value !== "string" || maxLength <= 0) {
    return;
  }
  const inputLimit = Math.min(value.length, maxLength * 4);
  let sanitized = "";
  for (let index = 0; index < inputLimit && sanitized.length < maxLength; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    index += character.length;
    if (
      codePoint >= 32 &&
      (codePoint < 127 || codePoint > 159) &&
      !TERMINAL_ACTIVE_UNICODE_PATTERN.test(character)
    ) {
      sanitized += character;
    }
  }
  const trimmed = sanitized.trim();
  return trimmed.length === 0 ? undefined : trimmed;
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

const boundedRetryDelay = (value: number): number | undefined =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_RETRY_AFTER_MS
    ? value
    : undefined;

const retryAfterValue = (
  rawValue: unknown,
  unit: "milliseconds" | "seconds-or-date"
): number | undefined => {
  if (
    typeof rawValue !== "string" ||
    rawValue.length > MAX_RETRY_AFTER_LENGTH
  ) {
    return;
  }
  const value = rawValue.trim();
  if (value.length === 0) {
    return;
  }
  if (unit === "milliseconds") {
    return INTEGER_PATTERN.test(value)
      ? boundedRetryDelay(Number(value))
      : undefined;
  }
  if (NUMERIC_PATTERN.test(value)) {
    return boundedRetryDelay(Number(value) * 1000);
  }
  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt)
    ? undefined
    : boundedRetryDelay(Math.max(0, retryAt - Date.now()));
};

const parseHeaders = (
  headers: unknown
): object | undefined | typeof PROVIDER_METADATA_FAILED => {
  if (headers === undefined) {
    return;
  }
  if (typeof headers !== "object" || headers === null) {
    return PROVIDER_METADATA_FAILED;
  }
  const prototype = safeRead(() => Reflect.getPrototypeOf(headers));
  return prototype === null || prototype === Object.prototype
    ? headers
    : PROVIDER_METADATA_FAILED;
};

const readOwnHeader = (
  headers: object,
  name: "retry-after" | "retry-after-ms"
): unknown | typeof PROVIDER_METADATA_FAILED => {
  const present = safeRead(() => Object.hasOwn(headers, name));
  if (present === PROVIDER_METADATA_FAILED || !present) {
    return present === false ? undefined : PROVIDER_METADATA_FAILED;
  }
  const descriptor = safeRead(() =>
    Reflect.getOwnPropertyDescriptor(headers, name)
  );
  if (descriptor === PROVIDER_METADATA_FAILED || descriptor === undefined) {
    return PROVIDER_METADATA_FAILED;
  }
  return safeRead(() => Reflect.get(headers, name));
};

const retryAfterMsFromHeaders = (rawHeaders: unknown): RetryAfterResult => {
  const headers = parseHeaders(rawHeaders);
  if (headers === PROVIDER_METADATA_FAILED || headers === undefined) {
    return headers;
  }
  const retryAfterMs = readOwnHeader(headers, "retry-after-ms");
  if (retryAfterMs === PROVIDER_METADATA_FAILED) {
    return PROVIDER_METADATA_FAILED;
  }
  if (retryAfterMs !== undefined) {
    return retryAfterValue(retryAfterMs, "milliseconds");
  }
  const retryAfter = readOwnHeader(headers, "retry-after");
  return retryAfter === PROVIDER_METADATA_FAILED
    ? PROVIDER_METADATA_FAILED
    : retryAfterValue(retryAfter, "seconds-or-date");
};

export const safeMessageForCategory = (category: TurnErrorCategory): string =>
  SAFE_MESSAGES[category];

export const transportErrorFromCode = (
  code: string
): TransportErrorFields | undefined => {
  if (TIMEOUT_ERROR_CODES.has(code)) {
    return { category: "timeout", code };
  }
  if (NETWORK_ERROR_CODES.has(code)) {
    return { category: "network", code };
  }
};

export const normalizeApiCallError = (
  error: APICallError
): ProviderMetadataResult => {
  const data = safeRead<unknown>(() => Reflect.get(error, "data"));
  const isRetryable = safeRead<unknown>(() =>
    Reflect.get(error, "isRetryable")
  );
  const responseHeaders = safeRead<unknown>(() =>
    Reflect.get(error, "responseHeaders")
  );
  const statusCode = safeRead<unknown>(() => Reflect.get(error, "statusCode"));
  if (
    data === PROVIDER_METADATA_FAILED ||
    isRetryable === PROVIDER_METADATA_FAILED ||
    responseHeaders === PROVIDER_METADATA_FAILED ||
    statusCode === PROVIDER_METADATA_FAILED ||
    typeof isRetryable !== "boolean" ||
    (statusCode !== undefined &&
      (typeof statusCode !== "number" ||
        !Number.isSafeInteger(statusCode) ||
        statusCode < 100 ||
        statusCode > 599))
  ) {
    return PROVIDER_METADATA_FAILED;
  }
  const retryAfterMs = retryAfterMsFromHeaders(responseHeaders);
  if (retryAfterMs === PROVIDER_METADATA_FAILED) {
    return PROVIDER_METADATA_FAILED;
  }
  return {
    category: categoryFromStatus(statusCode),
    observedRetryable: isRetryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(statusCode === undefined ? {} : { status: statusCode }),
    version: 1,
  };
};
