import type { ExtensionJsonValue } from "./extensions";

/**
 * Late-bound sink for provider observation events. The model (and its fetch
 * wrapper) is created before the extension host, so the host binds itself
 * here once it exists; `/reload` rebinds the replacement host the same way.
 */
export interface ProviderObservationEmitter {
  current?: (type: string, payload: ExtensionJsonValue) => void;
}

const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "retry-after",
  "x-request-id",
]);
const SAFE_RESPONSE_HEADER_PREFIXES = ["ratelimit-", "x-ratelimit-"] as const;

/**
 * Wrap `fetch` so provider HTTP traffic is observable by extensions as
 * read-only `provider:request` / `provider:response` / `provider:error` bus
 * events. URLs are stripped of credentials and query strings, request bodies
 * and headers are never exposed, and response headers pass a safelist.
 */
export function createProviderObservationFetch(
  emitter: ProviderObservationEmitter,
  baseFetch: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  const emit = (type: string, payload: ExtensionJsonValue): void => {
    try {
      emitter.current?.(type, payload);
    } catch {
      // Observation must never break provider traffic.
    }
  };
  return async (input, init) => {
    const url = redactedUrl(input);
    const method = requestMethod(input, init);
    emit("provider:request", { method, url });
    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (error) {
      emit("provider:error", {
        message: error instanceof Error ? error.message : String(error),
        url,
      });
      throw error;
    }
    emit("provider:response", {
      headers: safeResponseHeaders(response.headers),
      status: response.status,
      url,
    });
    return response;
  };
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method !== undefined) {
    return init.method.toUpperCase();
  }
  if (input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function rawUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return input.url;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input;
}

function redactedUrl(input: RequestInfo | URL): string {
  const raw = rawUrl(input);
  try {
    const url = new URL(raw);
    url.hash = "";
    url.password = "";
    url.search = "";
    url.username = "";
    return url.href;
  } catch {
    return "invalid-url";
  }
}

function safeResponseHeaders(
  headers: Headers
): Readonly<Record<string, string>> {
  const safe: Record<string, string> = {};
  headers.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (
      SAFE_RESPONSE_HEADERS.has(normalized) ||
      SAFE_RESPONSE_HEADER_PREFIXES.some((prefix) =>
        normalized.startsWith(prefix)
      )
    ) {
      safe[normalized] = value;
    }
  });
  return safe;
}
