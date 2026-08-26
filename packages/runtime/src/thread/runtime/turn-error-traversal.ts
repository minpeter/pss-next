import { APICallError, RetryError } from "ai";
import type { TransportErrorFields } from "./turn-error-provider-metadata";
import {
  boundedMetadataString,
  transportErrorFromCode,
} from "./turn-error-provider-metadata";

const MAX_ERROR_TRAVERSAL_NODES = 10_000;
export const TRAVERSAL_COMPLETE = Symbol("complete");
export const TRAVERSAL_FAILED = Symbol("failed");

export type TraversalResult<T> =
  | T
  | typeof TRAVERSAL_COMPLETE
  | typeof TRAVERSAL_FAILED;

const safeRead = <T>(read: () => T): T | typeof TRAVERSAL_FAILED => {
  try {
    return read();
  } catch {
    return TRAVERSAL_FAILED;
  }
};

const arrayValue = (
  value: unknown
): unknown[] | typeof TRAVERSAL_COMPLETE | typeof TRAVERSAL_FAILED => {
  try {
    return Array.isArray(value) ? value : TRAVERSAL_COMPLETE;
  } catch {
    return TRAVERSAL_FAILED;
  }
};

const isApiCallError = (value: object): value is APICallError =>
  APICallError.isInstance(value);

const isRetryError = (value: object): value is RetryError =>
  RetryError.isInstance(value);

const isAggregateError = (value: object): value is AggregateError =>
  value instanceof AggregateError;

const isIterable = (value: object): value is Iterable<unknown> => {
  const iterator = safeRead(() => Reflect.get(value, Symbol.iterator));
  return iterator !== TRAVERSAL_FAILED && typeof iterator === "function";
};

const enqueueArrayValues = (
  values: unknown[],
  worklist: unknown[],
  limit: number
): boolean => {
  const length = safeRead(() => Reflect.get(values, "length"));
  if (
    length === TRAVERSAL_FAILED ||
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    return false;
  }
  const start = Math.max(0, length - limit);
  for (let index = start; index < length; index += 1) {
    const value = safeRead(() => Reflect.get(values, index));
    if (value === TRAVERSAL_FAILED) {
      return false;
    }
    worklist.push(value);
  }
  return true;
};

const enqueueRetryChildren = (
  node: RetryError,
  worklist: unknown[],
  remaining: number
): boolean => {
  const cause = safeRead<unknown>(() => Reflect.get(node, "cause"));
  const rawErrors = safeRead<unknown>(() => Reflect.get(node, "errors"));
  const lastError = safeRead<unknown>(() => Reflect.get(node, "lastError"));
  if (
    cause === TRAVERSAL_FAILED ||
    rawErrors === TRAVERSAL_FAILED ||
    lastError === TRAVERSAL_FAILED
  ) {
    return false;
  }
  const errors = arrayValue(rawErrors);
  if (errors === TRAVERSAL_FAILED || errors === TRAVERSAL_COMPLETE) {
    return false;
  }
  if (remaining > 2) {
    worklist.push(cause);
  }
  if (!enqueueArrayValues(errors, worklist, Math.max(0, remaining - 1))) {
    return false;
  }
  if (remaining > 0) {
    worklist.push(lastError);
  }
  return true;
};

const enqueueAggregateChildren = (
  node: AggregateError,
  worklist: unknown[],
  seenCount: number
): boolean => {
  const rawErrors = safeRead<unknown>(() => Reflect.get(node, "errors"));
  if (rawErrors === TRAVERSAL_FAILED) {
    return false;
  }
  const childLimit = MAX_ERROR_TRAVERSAL_NODES - seenCount - worklist.length;
  const errors = arrayValue(rawErrors);
  if (errors === TRAVERSAL_FAILED) {
    return false;
  }
  if (errors !== TRAVERSAL_COMPLETE) {
    return enqueueArrayValues(errors, worklist, childLimit);
  }
  if (
    typeof rawErrors !== "object" ||
    rawErrors === null ||
    !isIterable(rawErrors)
  ) {
    return false;
  }
  return (
    safeRead(() => {
      for (const error of rawErrors) {
        if (worklist.length === MAX_ERROR_TRAVERSAL_NODES - seenCount) {
          break;
        }
        worklist.push(error);
      }
      return true;
    }) !== TRAVERSAL_FAILED
  );
};

const enqueueChildErrors = (
  node: object,
  worklist: unknown[],
  seenCount: number
): boolean => {
  const remaining = MAX_ERROR_TRAVERSAL_NODES - seenCount - worklist.length;
  try {
    if (isRetryError(node)) {
      return enqueueRetryChildren(node, worklist, remaining);
    }
  } catch {
    return false;
  }
  const cause = safeRead<unknown>(() => Reflect.get(node, "cause"));
  if (cause === TRAVERSAL_FAILED) {
    return false;
  }
  if (remaining > 0) {
    worklist.push(cause);
  }
  try {
    return (
      !isAggregateError(node) ||
      enqueueAggregateChildren(node, worklist, seenCount)
    );
  } catch {
    return false;
  }
};

export const findApiCallError = (
  error: unknown
): TraversalResult<APICallError> => {
  const seen = new Set<object>();
  const worklist: unknown[] = [error];
  while (worklist.length > 0) {
    const node = worklist.pop();
    if (typeof node !== "object" || node === null || seen.has(node)) {
      continue;
    }
    if (seen.size === MAX_ERROR_TRAVERSAL_NODES) {
      return TRAVERSAL_FAILED;
    }
    seen.add(node);
    try {
      if (isApiCallError(node)) {
        return node;
      }
    } catch {
      return TRAVERSAL_FAILED;
    }
    if (!enqueueChildErrors(node, worklist, seen.size)) {
      return TRAVERSAL_FAILED;
    }
  }
  return TRAVERSAL_COMPLETE;
};

const findNamedErrorField = (
  error: unknown,
  field: "code" | "name"
): TraversalResult<string> => {
  const seen = new Set<object>();
  const worklist: unknown[] = [error];
  while (worklist.length > 0) {
    const node = worklist.pop();
    if (typeof node !== "object" || node === null || seen.has(node)) {
      continue;
    }
    if (seen.size === MAX_ERROR_TRAVERSAL_NODES) {
      return TRAVERSAL_FAILED;
    }
    seen.add(node);
    const rawFieldValue = safeRead(() => Reflect.get(node, field));
    const cause = safeRead(() => Reflect.get(node, "cause"));
    if (rawFieldValue === TRAVERSAL_FAILED || cause === TRAVERSAL_FAILED) {
      return TRAVERSAL_FAILED;
    }
    const fieldValue = boundedMetadataString(rawFieldValue, 128);
    if (fieldValue !== undefined) {
      return fieldValue;
    }
    worklist.push(cause);
  }
  return TRAVERSAL_COMPLETE;
};

export const classifyTransportError = (
  error: unknown
): TraversalResult<TransportErrorFields> => {
  const errorName = findNamedErrorField(error, "name");
  if (errorName === TRAVERSAL_FAILED) {
    return TRAVERSAL_FAILED;
  }
  if (errorName === "AbortError") {
    return { category: "cancelled" };
  }
  if (errorName === "TimeoutError") {
    return { category: "timeout" };
  }
  if (errorName === "CompactionDeadlineExceededError") {
    return { category: "timeout", code: "COMPACTION_DEADLINE_EXCEEDED" };
  }
  const errorCode = findNamedErrorField(error, "code");
  if (errorCode === TRAVERSAL_COMPLETE || errorCode === TRAVERSAL_FAILED) {
    return errorCode;
  }
  return transportErrorFromCode(errorCode) ?? TRAVERSAL_COMPLETE;
};
