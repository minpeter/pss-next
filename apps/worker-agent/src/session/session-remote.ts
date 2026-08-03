import {
  ReplayEventsResponseSchema,
  type StoredThreadEvent,
  type SubmitTurnRequest,
  serializeSessionChannel,
  serializeThreadEventCursor,
  type ThreadEventCursor,
} from "./session-contract";

interface RemoteSessionEventStreamConfig {
  readonly after?: ThreadEventCursor;
  readonly channel: SubmitTurnRequest["channel"];
  readonly endpoint: string;
  readonly fetch?: (request: Request) => Promise<Response>;
  /** Overrides used to make reconnect pacing deterministic in tests. */
  readonly reconnect?: {
    readonly initialDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly random?: () => number;
    readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
  readonly sessionScopeKey?: string;
  readonly signal?: AbortSignal;
  readonly token?: string;
}

const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 250;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 10_000;

export async function* streamRemoteSessionEvents(
  config: RemoteSessionEventStreamConfig
): AsyncIterable<StoredThreadEvent> {
  const fetchSessionEvents = config.fetch ?? ((request) => fetch(request));
  let cursor = config.after;
  let reconnectAttempt = 0;

  while (!config.signal?.aborted) {
    const request = createSessionEventRequest(config, cursor);
    const response = await fetchSessionEvents(request);
    if (!response.ok) {
      throw new RemoteSessionEventStreamError(response.status);
    }

    let madeProgress = false;
    for await (const event of decodeSessionEventStream(response)) {
      madeProgress = true;
      cursor = event.cursor;
      yield event;
    }

    // A successful response alone is not evidence that the connection was
    // healthy: an intermediary can repeatedly return an immediately closed
    // 200 response. Only an event resets the reconnect pacing.
    if (madeProgress) {
      reconnectAttempt = 0;
    }
    if (!(await waitForReconnect(config, reconnectAttempt))) {
      return;
    }
    reconnectAttempt += 1;
  }
}

function createSessionEventRequest(
  config: RemoteSessionEventStreamConfig,
  cursor: ThreadEventCursor | undefined
): Request {
  const url = new URL(config.endpoint);
  url.searchParams.set("channel", serializeSessionChannel(config.channel));
  if (cursor) {
    url.searchParams.set("after", serializeThreadEventCursor(cursor));
  }
  if (config.sessionScopeKey) {
    url.searchParams.set("sessionScopeKey", config.sessionScopeKey);
  }
  return new Request(url, {
    headers: {
      accept: "text/event-stream",
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
    },
    ...(config.signal ? { signal: config.signal } : {}),
  });
}

async function waitForReconnect(
  config: RemoteSessionEventStreamConfig,
  attempt: number
): Promise<boolean> {
  const initialDelayMs =
    config.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
  const maxDelayMs =
    config.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  const exponentialDelay = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt);
  const random = config.reconnect?.random ?? Math.random;
  const delayMs = Math.floor(exponentialDelay * (0.5 + random() * 0.5));
  try {
    await (config.reconnect?.delay ?? abortableDelay)(delayMs, config.signal);
    return true;
  } catch (error) {
    if (config.signal?.aborted) {
      return false;
    }
    throw error;
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError")
    );
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, ms);
    signal?.addEventListener("abort", abort, { once: true });

    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    }
  });
}

async function* decodeSessionEventStream(
  response: Response
): AsyncIterable<StoredThreadEvent> {
  if (!response.body) {
    throw new RemoteSessionEventStreamError(response.status, "missing body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      buffer += decoder
        .decode(result.value, { stream: true })
        .replaceAll("\r\n", "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = parseSessionEventFrame(frame);
        if (event) {
          yield event;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseSessionEventFrame(frame: string): StoredThreadEvent | undefined {
  const lines = frame.split("\n");
  if (!lines.includes("event: thread-event")) {
    return;
  }
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) {
    return;
  }
  const parsed: unknown = JSON.parse(data);
  const replay = ReplayEventsResponseSchema.parse({ events: [parsed] });
  const event = replay.events[0];
  if (!event) {
    throw new RemoteSessionEventStreamError(200, "invalid event");
  }
  return event;
}

class RemoteSessionEventStreamError extends Error {
  constructor(status: number, detail = "request failed") {
    super(`session event stream ${detail}: ${status}`);
    this.name = "RemoteSessionEventStreamError";
  }
}
