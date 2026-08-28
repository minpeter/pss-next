import type {
  FaultGeneration,
  RequestDecisionEvent,
  TypedFaultRule,
} from "./fault-proxy-types";
import {
  BoundaryInputError,
  parseEvent,
  parseGeneration,
  requireLoopbackUrl,
} from "./fault-proxy-types";

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

  async generation(): Promise<FaultGeneration> {
    const response = await this.fetchImpl(
      new URL("/generation", this.endpoint),
      { signal: AbortSignal.timeout(2000) }
    );
    if (!response.ok) {
      throw new BoundaryInputError(`fault control returned ${response.status}`);
    }
    return parseGeneration(await response.json());
  }
}
