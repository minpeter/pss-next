import type { IncomingMessage, ServerResponse } from "node:http";
import {
  hasMatchingFaultWrite,
  matchesFaultKey,
} from "./fault-proxy-key-scope";
import type {
  FaultGeneration,
  ProxyDecision,
  ProxyOutcome,
  ProxyRequest,
  RequestDecisionEvent,
  TypedFaultRule,
} from "./fault-proxy-types";
import { BoundaryInputError, parseFaultRule } from "./fault-proxy-types";

const MAX_RETAINED_EVENTS = 1000;

export class FaultControlState {
  /** Mutable coordinator state; generations and published events remain immutable. */
  private current: FaultGeneration = Object.freeze({
    id: 0,
    installedAtMs: 0,
    rule: Object.freeze({ kind: "pass" }),
  });
  private readonly completedEvents: RequestDecisionEvent[] = [];
  private nextGeneration = 1;
  private readonly now: () => number;
  private readonly pending = new WeakMap<ProxyDecision, ProxyRequest>();
  private readonly syntheticCounts = new Map<number, number>();
  private readonly writtenKeys = new Set<string>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  install(rule: TypedFaultRule): FaultGeneration {
    const frozenRule = Object.freeze({ ...rule });
    const generation = Object.freeze({
      id: this.nextGeneration,
      installedAtMs: this.now(),
      rule: frozenRule,
    });
    this.nextGeneration += 1;
    this.current = generation;
    this.syntheticCounts.clear();
    this.writtenKeys.clear();
    return generation;
  }

  generation(): FaultGeneration {
    return this.current;
  }

  decide(request: ProxyRequest): ProxyDecision {
    const rule = this.current.rule;
    const used = this.syntheticCounts.get(this.current.id) ?? 0;
    let decision: ProxyDecision = {
      generation: this.current.id,
      kind: "upstream",
    };
    switch (rule.kind) {
      case "pass":
        break;
      case "http_500":
        if (matchesFaultKey(rule.key, request.key) && used < rule.count) {
          decision = this.synthetic(500);
        }
        break;
      case "throttle_429":
        if (matchesFaultKey(rule.key, request.key) && used < rule.count) {
          decision = this.synthetic(429, {
            "retry-after": String(rule.retryAfterSeconds),
          });
        }
        break;
      case "read_after_write":
        if (
          matchesFaultKey(rule.key, request.key) &&
          (request.method === "GET" || request.method === "HEAD") &&
          hasMatchingFaultWrite(this.writtenKeys, this.current.id, rule.key) &&
          used < rule.count
        ) {
          decision = this.synthetic(404);
        }
        break;
      case "conditional_412":
        if (
          matchesFaultKey(rule.key, request.key) &&
          request.method === "PUT" &&
          (request.headers["if-match"] !== undefined ||
            request.headers["if-none-match"] !== undefined) &&
          used < rule.count
        ) {
          decision = this.synthetic(412);
        }
        break;
      default:
        return assertNever(rule);
    }
    if (decision.kind === "synthetic") {
      this.syntheticCounts.set(this.current.id, used + 1);
    }
    this.pending.set(decision, request);
    return decision;
  }

  complete(decision: ProxyDecision, outcome: ProxyOutcome): void {
    const request = this.pending.get(decision);
    if (request === undefined) {
      throw new BoundaryInputError(
        "decision does not belong to this control state"
      );
    }
    this.pending.delete(decision);
    if (
      decision.kind === "upstream" &&
      request.method === "PUT" &&
      outcome.status !== null &&
      outcome.status >= 200 &&
      outcome.status < 300
    ) {
      this.writtenKeys.add(`${decision.generation}:${request.key}`);
    }
    this.completedEvents.push(
      Object.freeze({
        error: outcome.error,
        generation: decision.generation,
        key: request.key,
        method: request.method,
        status: outcome.status,
        synthetic: decision.kind === "synthetic",
        upstreamCalled: decision.kind === "upstream",
      })
    );
    if (this.completedEvents.length > MAX_RETAINED_EVENTS) {
      this.completedEvents.shift();
    }
  }

  events(): readonly RequestDecisionEvent[] {
    return Object.freeze([...this.completedEvents]);
  }

  private synthetic(
    status: 404 | 412 | 429 | 500 | 503,
    headers: Readonly<Record<string, string>> = {}
  ): ProxyDecision {
    return {
      generation: this.current.id,
      headers: Object.freeze({ ...headers }),
      kind: "synthetic",
      status,
    };
  }
}

export async function handleFaultControl(
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
    const generation = state.install(parseFaultRule(await readJson(request)));
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

function isLoopbackAddress(value: string | undefined): boolean {
  return (
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1"
  );
}

function assertNever(value: never): never {
  throw new BoundaryInputError(`unhandled rule: ${JSON.stringify(value)}`);
}
