import { BoundaryInputError, requireLoopbackUrl } from "./fault-proxy-types";

export interface ToxiproxyDefinition {
  readonly listen: string;
  readonly name: string;
  readonly upstream: string;
}

interface ToxicDefinition {
  readonly attributes: Readonly<Record<string, number>>;
  readonly name: string;
  readonly stream: "downstream";
  readonly toxicity: 1;
  readonly type: "latency" | "reset_peer" | "timeout";
}

interface RequestOptions {
  readonly acceptedStatuses?: readonly number[];
  readonly body?: unknown;
  readonly method: "DELETE" | "GET" | "POST";
  readonly path: string;
}

export class ToxiproxyClient {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(endpoint: string, fetchImpl: typeof fetch = fetch) {
    this.endpoint = requireLoopbackUrl(endpoint, "Toxiproxy control endpoint");
    this.fetchImpl = fetchImpl;
  }

  async createProxy(definition: ToxiproxyDefinition): Promise<void> {
    const body = { ...definition, enabled: true };
    const response = await this.send({
      acceptedStatuses: [409],
      body,
      method: "POST",
      path: "/proxies",
    });
    if (response.status === 409) {
      await this.send({
        body,
        method: "POST",
        path: `/proxies/${encodeURIComponent(definition.name)}`,
      });
    }
  }

  async clearToxics(proxyName: string): Promise<void> {
    const response = await this.send({
      method: "GET",
      path: `/proxies/${encodeURIComponent(proxyName)}/toxics`,
    });
    const value: unknown = await response.json();
    if (!Array.isArray(value)) {
      throw new BoundaryInputError(
        "Toxiproxy toxics response must be an array"
      );
    }
    for (const toxic of value) {
      if (!isRecord(toxic) || typeof toxic.name !== "string") {
        throw new BoundaryInputError("Toxiproxy toxic has no name");
      }
      await this.send({
        method: "DELETE",
        path: `/proxies/${encodeURIComponent(proxyName)}/toxics/${encodeURIComponent(toxic.name)}`,
      });
    }
  }

  async deleteProxy(proxyName: string): Promise<void> {
    await this.send({
      acceptedStatuses: [404],
      method: "DELETE",
      path: `/proxies/${encodeURIComponent(proxyName)}`,
    });
  }

  async addLatency(proxyName: string, latencyMs: number): Promise<void> {
    await this.addToxic(proxyName, {
      attributes: { jitter: 0, latency: positiveMilliseconds(latencyMs) },
      name: "s3-latency",
      stream: "downstream",
      toxicity: 1,
      type: "latency",
    });
  }

  async addTimeout(proxyName: string, timeoutMs: number): Promise<void> {
    await this.addToxic(proxyName, {
      attributes: { timeout: positiveMilliseconds(timeoutMs) },
      name: "s3-timeout",
      stream: "downstream",
      toxicity: 1,
      type: "timeout",
    });
  }

  async addReset(proxyName: string): Promise<void> {
    await this.addToxic(proxyName, {
      attributes: { timeout: 0 },
      name: "s3-reset",
      stream: "downstream",
      toxicity: 1,
      type: "reset_peer",
    });
  }

  private async addToxic(
    proxyName: string,
    toxic: ToxicDefinition
  ): Promise<void> {
    await this.send({
      body: toxic,
      method: "POST",
      path: `/proxies/${encodeURIComponent(proxyName)}/toxics`,
    });
  }

  private async send(options: RequestOptions): Promise<Response> {
    const response = await this.fetchImpl(
      new URL(options.path, this.endpoint),
      {
        ...(options.body === undefined
          ? {}
          : {
              body: JSON.stringify(options.body),
              headers: { "content-type": "application/json" },
            }),
        method: options.method,
        signal: AbortSignal.timeout(2000),
      }
    );
    if (!(response.ok || options.acceptedStatuses?.includes(response.status))) {
      throw new BoundaryInputError(
        `Toxiproxy control returned ${response.status}`
      );
    }
    return response;
  }
}

function positiveMilliseconds(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new BoundaryInputError("toxic duration must be a positive integer");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
