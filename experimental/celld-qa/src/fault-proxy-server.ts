import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { FaultControlState, handleFaultControl } from "./fault-proxy-control";
import {
  closeServer,
  listenServer,
  tcpPort,
} from "./fault-proxy-server-lifecycle";
import {
  BoundaryInputError,
  type ProxyDecision,
  requireLoopbackUrl,
} from "./fault-proxy-types";

export interface FaultProxyOptions {
  readonly controlHost?: string;
  readonly controlPort: number;
  readonly dataPort: number;
  readonly state?: FaultControlState;
  readonly upstreamUrl: string;
}

export interface StartedFaultProxy {
  readonly close: () => Promise<void>;
  readonly controlUrl: string;
  readonly dataUrl: string;
  readonly state: FaultControlState;
}

interface ProxyContext {
  readonly state: FaultControlState;
  readonly upstream: URL;
}

interface SyntheticContext {
  readonly decision: Extract<ProxyDecision, { readonly kind: "synthetic" }>;
  readonly state: FaultControlState;
}

export async function startFaultProxy(
  options: FaultProxyOptions
): Promise<StartedFaultProxy> {
  const controlHost = options.controlHost ?? "127.0.0.1";
  if (controlHost !== "127.0.0.1" && controlHost !== "::1") {
    throw new BoundaryInputError("control host must be loopback");
  }
  const upstream = requireLoopbackUrl(options.upstreamUrl, "S3 upstream");
  const state = options.state ?? new FaultControlState();
  const context = { state, upstream };
  const dataServer = createServer((request, response) =>
    proxyRequest(request, response, context)
  );
  const controlServer = createServer((request, response) => {
    handleFaultControl(request, response, state).catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "invalid control request";
      if (!response.headersSent) {
        response.writeHead(400, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: message }));
    });
  });
  const startup = await Promise.allSettled([
    listenServer(dataServer, options.dataPort, "127.0.0.1"),
    listenServer(controlServer, options.controlPort, controlHost),
  ]);
  const failure = startup.find((result) => result.status === "rejected");
  if (failure !== undefined) {
    await Promise.allSettled([
      closeServer(dataServer),
      closeServer(controlServer),
    ]);
    throw failure.reason;
  }
  const dataPort = tcpPort(dataServer);
  const controlPort = tcpPort(controlServer);
  return Object.freeze({
    close: async () =>
      Promise.all([closeServer(dataServer), closeServer(controlServer)]).then(
        () => undefined
      ),
    controlUrl: `http://127.0.0.1:${controlPort}`,
    dataUrl: `http://127.0.0.1:${dataPort}`,
    state,
  });
}

function proxyRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  context: ProxyContext
): void {
  const target = proxyTarget(incoming.url, context.upstream);
  if (target === null) {
    incoming.resume();
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("invalid proxy target");
    return;
  }
  const decision = context.state.decide({
    headers: incoming.headers,
    key: target.pathname,
    method: incoming.method ?? "GET",
  });
  if (decision.kind === "synthetic") {
    sendSynthetic(incoming, response, { decision, state: context.state });
    return;
  }
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  let completed = false;
  const complete = (
    outcome: Readonly<{ error: string | null; status: number | null }>
  ): void => {
    if (completed) {
      return;
    }
    completed = true;
    context.state.complete(decision, outcome);
  };
  const outgoing = send(
    target,
    { headers: incoming.headers, method: incoming.method },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers
      );
      upstreamResponse.pipe(response);
      upstreamResponse.once("end", () => {
        complete({
          error: null,
          status: upstreamResponse.statusCode ?? 502,
        });
      });
      upstreamResponse.once("aborted", () => {
        complete({ error: "upstream response aborted", status: null });
        response.destroy();
      });
      upstreamResponse.once("error", (error) => {
        complete({ error: error.message, status: null });
        response.destroy(error);
      });
    }
  );
  outgoing.once("error", (error) => {
    complete({ error: error.message, status: null });
    if (!response.destroyed) {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain" });
      }
      response.end("upstream unavailable");
    }
  });
  incoming.once("aborted", () => {
    complete({ error: "downstream request aborted", status: null });
    outgoing.destroy();
  });
  incoming.once("error", (error) => {
    complete({ error: error.message, status: null });
    outgoing.destroy(error);
  });
  response.once("close", () => {
    if (!response.writableEnded) {
      complete({ error: "downstream response closed", status: null });
      outgoing.destroy();
    }
  });
  incoming.pipe(outgoing);
}

function proxyTarget(value: string | undefined, upstream: URL): URL | null {
  const requestTarget = value ?? "/";
  if (!requestTarget.startsWith("/") || requestTarget.startsWith("//")) {
    return null;
  }
  try {
    const target = new URL(requestTarget, upstream);
    return target.origin === upstream.origin ? target : null;
  } catch {
    return null;
  }
}

function sendSynthetic(
  incoming: IncomingMessage,
  response: ServerResponse,
  context: SyntheticContext
): void {
  incoming.resume();
  response.writeHead(context.decision.status, {
    "content-type": "application/xml",
    ...context.decision.headers,
  });
  response.end(
    `<Error><Code>${errorCode(context.decision.status)}</Code></Error>`
  );
  context.state.complete(context.decision, {
    error: null,
    status: context.decision.status,
  });
}

function errorCode(status: 404 | 412 | 429 | 500 | 503): string {
  switch (status) {
    case 404:
      return "NoSuchKey";
    case 412:
      return "PreconditionFailed";
    case 429:
      return "SlowDown";
    case 500:
      return "InternalError";
    case 503:
      return "ServiceUnavailable";
    default:
      return assertNever(status);
  }
}

function assertNever(value: never): never {
  throw new BoundaryInputError(`unsupported synthetic status: ${value}`);
}

function cliValue(
  args: readonly string[],
  key: string,
  fallback: string
): string {
  const index = args.indexOf(key);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const proxy = await startFaultProxy({
    controlPort: Number(cliValue(args, "--control-port", "14568")),
    dataPort: Number(cliValue(args, "--data-port", "14567")),
    upstreamUrl: cliValue(args, "--upstream", "http://127.0.0.1:14666"),
  });
  process.stdout.write(
    `${JSON.stringify({ controlUrl: proxy.controlUrl, dataUrl: proxy.dataUrl })}\n`
  );
}
