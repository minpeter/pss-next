import type {
  FaultGeneration,
  ProxyDecision,
  ProxyOutcome,
  ProxyRequest,
  RequestDecisionEvent,
  TypedFaultRule,
} from "./fault-proxy-types";
import {
  BoundaryInputError,
  parseEvent,
  parseGeneration,
  requireLoopbackUrl,
} from "./fault-proxy-types";

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
        if (request.key === rule.key && used < rule.count) {
          decision = this.synthetic(500);
        }
        break;
      case "throttle_429":
        if (request.key === rule.key && used < rule.count) {
          decision = this.synthetic(429, {
            "retry-after": String(rule.retryAfterSeconds),
          });
        }
        break;
      case "read_after_write":
        if (
          request.key === rule.key &&
          (request.method === "GET" || request.method === "HEAD") &&
          this.writtenKeys.has(`${this.current.id}:${rule.key}`) &&
          used < rule.count
        ) {
          decision = this.synthetic(404);
        }
        break;
      case "conditional_412":
        if (
          request.key === rule.key &&
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
  }

  events(): readonly RequestDecisionEvent[] {
    return Object.freeze([...this.completedEvents]);
  }

  private synthetic(
    status: 404 | 412 | 429 | 500,
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

export class FaultProxyControlClient {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(endpoint: string, fetchImpl: typeof fetch = fetch) {
    this.endpoint = requireLoopbackUrl(
      endpoint,
      "fault proxy control endpoint"
    );
    this.fetchImpl = fetchImpl;
  }

  async install(rule: TypedFaultRule): Promise<FaultGeneration> {
    const response = await this.fetchImpl(
      new URL("/generation", this.endpoint),
      {
        body: JSON.stringify(rule),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(2000),
      }
    );
    if (!response.ok) {
      throw new BoundaryInputError(`fault control returned ${response.status}`);
    }
    return parseGeneration(await response.json());
  }

  async events(): Promise<readonly RequestDecisionEvent[]> {
    const response = await this.fetchImpl(new URL("/events", this.endpoint), {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      throw new BoundaryInputError(`fault control returned ${response.status}`);
    }
    const value: unknown = await response.json();
    if (!Array.isArray(value)) {
      throw new BoundaryInputError("fault events must be an array");
    }
    return value.map(parseEvent);
  }
}

function assertNever(value: never): never {
  throw new BoundaryInputError(`unhandled rule: ${JSON.stringify(value)}`);
}
