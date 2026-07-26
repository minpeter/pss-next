import type { ExtensionJsonValue } from "./extensions";

/**
 * Late-bound sink for provider observation events. The model (and its fetch
 * wrapper) is created before the extension host, so the host binds itself
 * here once it exists; `/reload` rebinds the replacement host the same way.
 */
export interface ProviderObservationEmitter {
  current?: (type: string, payload: ExtensionJsonValue) => void;
}

const URL_LIKE_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s"')]+/gi;
/**
 * Scheme-less inputs still leak query/fragment secrets through error
 * messages (`gateway.example/v1?secret-token`, `host/path#secret`), so any
 * token carrying a `?` or `#` suffix is redacted wholesale.
 */
const QUERY_TOKEN_PATTERN = /[^\s"')?#]*[?#][^\s"')]+/g;
const MAX_ERROR_MESSAGE_LENGTH = 256;
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
  return async (input, init) => {
    // Capture the sink once per request so a `/reload` rebinding mid-flight
    // cannot split one request's events across different hosts or leak
    // observations of traffic a runtime never initiated.
    const sink = emitter.current;
    const emit = (type: string, payload: ExtensionJsonValue): void => {
      try {
        sink?.(type, payload);
      } catch {
        // Observation must never break provider traffic.
      }
    };
    const url = redactedUrl(input);
    const method = requestMethod(input, init);
    emit("provider:request", { method, url });
    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (error) {
      emit("provider:error", {
        message: redactedErrorMessage(error),
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

/**
 * Transport errors can embed the raw request URL (including credentials or
 * query API keys); scrub URL-like tokens before publishing to observers.
 */
function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(URL_LIKE_PATTERN, "<redacted-url>")
    .replace(QUERY_TOKEN_PATTERN, "<redacted-url>")
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
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
