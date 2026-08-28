import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { FaultControlState } from "./fault-proxy-control";
import {
  BoundaryInputError,
  type ProxyDecision,
  parseFaultRule,
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
    handleControl(request, response, state).catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "invalid control request";
      if (!response.headersSent) {
        response.writeHead(400, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: message }));
    });
  });
  await Promise.all([
    listen(dataServer, options.dataPort, "127.0.0.1"),
    listen(controlServer, options.controlPort, controlHost),
  ]);
  const dataPort = tcpPort(dataServer);
  const controlPort = tcpPort(controlServer);
  return Object.freeze({
    close: async () =>
      Promise.all([close(dataServer), close(controlServer)]).then(
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
  const key = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;
  const decision = context.state.decide({
    headers: incoming.headers,
    key,
    method: incoming.method ?? "GET",
  });
  if (decision.kind === "synthetic") {
    sendSynthetic(incoming, response, { decision, state: context.state });
    return;
  }
  const target = new URL(incoming.url ?? "/", context.upstream);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
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
        context.state.complete(decision, {
          error: null,
          status: upstreamResponse.statusCode ?? 502,
        });
      });
    }
  );
  outgoing.once("error", (error) => {
    context.state.complete(decision, { error: error.message, status: null });
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain" });
    }
    response.end("upstream unavailable");
  });
  incoming.pipe(outgoing);
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

async function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
  state: FaultControlState
): Promise<void> {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    response.writeHead(403).end();
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(state.events()));
    return;
  }
  if (request.method === "GET" && url.pathname === "/generation") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(state.generation()));
    return;
  }
  if (request.method === "POST" && url.pathname === "/generation") {
    const body = await readJson(request);
    const generation = state.install(parseFaultRule(body));
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify(generation));
    return;
  }
  response.writeHead(404).end();
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) {
      throw new BoundaryInputError("control body must be bytes");
    }
    size += chunk.length;
    if (size > 65_536) {
      throw new BoundaryInputError("control body exceeds 64 KiB");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function tcpPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new BoundaryInputError("proxy has no TCP address");
  }
  return address.port;
}

function isLoopbackAddress(value: string | undefined): boolean {
  return (
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1"
  );
}

function errorCode(status: 404 | 412 | 429 | 500): string {
  switch (status) {
    case 404:
      return "NoSuchKey";
    case 412:
      return "PreconditionFailed";
    case 429:
      return "SlowDown";
    case 500:
      return "InternalError";
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
