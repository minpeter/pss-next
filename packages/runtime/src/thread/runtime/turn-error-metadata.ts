import type { TurnErrorMetadataV1 } from "../protocol/events";
import {
  normalizeApiCallError,
  PROVIDER_METADATA_FAILED,
  safeMessageForCategory,
} from "./turn-error-provider-metadata";
import {
  classifyTransportError,
  findApiCallError,
  TRAVERSAL_COMPLETE,
  TRAVERSAL_FAILED,
} from "./turn-error-traversal";

export interface NormalizedTurnError {
  readonly error?: TurnErrorMetadataV1;
  readonly message?: string;
}

const SAFE_UNKNOWN_ERROR: NormalizedTurnError = {
  error: { category: "unknown", version: 1 },
  message: "The request failed.",
};

const safeCause = (error: object): unknown | typeof TRAVERSAL_FAILED => {
  try {
    return Reflect.get(error, "cause");
  } catch {
    return TRAVERSAL_FAILED;
  }
};

export const normalizeTurnError = (error: unknown): NormalizedTurnError => {
  const apiError = findApiCallError(error);
  if (apiError === TRAVERSAL_FAILED) {
    return SAFE_UNKNOWN_ERROR;
  }
  if (apiError !== TRAVERSAL_COMPLETE) {
    const apiCause = safeCause(apiError);
    const normalized = normalizeApiCallError(apiError);
    if (
      apiCause === TRAVERSAL_FAILED ||
      normalized === PROVIDER_METADATA_FAILED
    ) {
      return SAFE_UNKNOWN_ERROR;
    }
    const transport =
      normalized.status === undefined
        ? classifyTransportError(apiCause)
        : TRAVERSAL_COMPLETE;
    if (transport === TRAVERSAL_FAILED) {
      return SAFE_UNKNOWN_ERROR;
    }
    const errorMetadata =
      transport === TRAVERSAL_COMPLETE
        ? normalized
        : {
            ...normalized,
            category: transport.category,
            ...(transport.code === undefined ? {} : { code: transport.code }),
          };
    return {
      error: errorMetadata,
      message: safeMessageForCategory(errorMetadata.category),
    };
  }

  const transport = classifyTransportError(error);
  if (transport === TRAVERSAL_FAILED) {
    return SAFE_UNKNOWN_ERROR;
  }
  if (transport !== TRAVERSAL_COMPLETE) {
    return {
      error: { ...transport, version: 1 },
      message: safeMessageForCategory(transport.category),
    };
  }
  return SAFE_UNKNOWN_ERROR;
};
