import { FaultProxyControlClient } from "./fault-proxy-control";
import {
  BoundaryInputError,
  FAULT_KINDS,
  type FaultKind,
  requireLoopbackUrl,
  type S3FaultReport,
  type ScenarioResult,
} from "./fault-proxy-types";
import { ToxiproxyClient } from "./toxiproxy-client";

export interface LiveCampaignOptions {
  readonly controlUrl: string;
  readonly proxyUrl: string;
  readonly toxiproxyUrl: string;
}

interface ProbeResult {
  readonly elapsedMs: number;
  readonly response: Response | null;
  readonly transportInterrupted: boolean;
}

interface LiveContext {
  readonly control: FaultProxyControlClient;
  readonly key: string;
  readonly proxyUrl: URL;
  readonly toxiproxy: ToxiproxyClient;
}

export async function runS3FaultCampaign(
  runScenario: (kind: FaultKind) => Promise<ScenarioResult>
): Promise<S3FaultReport> {
  const scenarios: ScenarioResult[] = [];
  for (const kind of FAULT_KINDS) {
    const result = await runScenario(kind);
    if (result.kind !== kind) {
      throw new BoundaryInputError(
        `scenario returned ${result.kind}, expected ${kind}`
      );
    }
    scenarios.push(Object.freeze({ ...result }));
  }
  return Object.freeze({
    ok: scenarios.every((scenario) => scenario.observed),
    scenarios: Object.freeze(scenarios),
  });
}

export async function runLiveS3FaultCampaign(
  options: LiveCampaignOptions
): Promise<S3FaultReport> {
  const proxyUrl = requireLoopbackUrl(
    options.proxyUrl,
    "fault proxy data endpoint"
  );
  const context: LiveContext = {
    control: new FaultProxyControlClient(options.controlUrl),
    key: "/celld-qa-fault/object",
    proxyUrl,
    toxiproxy: new ToxiproxyClient(options.toxiproxyUrl),
  };
  await context.toxiproxy.createProxy({
    listen: "0.0.0.0:8666",
    name: "s3-loopback",
    upstream: "localstack:4566",
  });
  await context.control.install({ kind: "pass" });
  await context.toxiproxy.clearToxics("s3-loopback");
  const bucket = await requestProbe(proxyUrl, "/celld-qa-fault", {
    method: "PUT",
  });
  if (
    bucket.response === null ||
    (!bucket.response.ok && bucket.response.status !== 409)
  ) {
    throw new BoundaryInputError(
      `fault fixture bucket returned ${bucket.response?.status ?? "transport-error"}`
    );
  }
  try {
    return await runS3FaultCampaign((kind) => runLiveScenario(kind, context));
  } finally {
    await context.toxiproxy.clearToxics("s3-loopback");
    await context.toxiproxy.deleteProxy("s3-loopback");
  }
}

async function runLiveScenario(
  kind: FaultKind,
  context: LiveContext
): Promise<ScenarioResult> {
  await context.toxiproxy.clearToxics("s3-loopback");
  switch (kind) {
    case "pass": {
      await context.control.install({ kind: "pass" });
      const probe = await requestProbe(context.proxyUrl, context.key);
      return result(
        kind,
        probe.response !== null,
        `status=${probe.response?.status ?? "transport-error"}`
      );
    }
    case "latency": {
      await context.control.install({ kind: "pass" });
      await context.toxiproxy.addLatency("s3-loopback", 125);
      const probe = await requestProbe(context.proxyUrl, context.key);
      return result(
        kind,
        probe.elapsedMs >= 100,
        `elapsedMs=${Math.round(probe.elapsedMs)}`
      );
    }
    case "timeout": {
      await context.control.install({ kind: "pass" });
      await context.toxiproxy.addTimeout("s3-loopback", 50);
      const probe = await requestProbe(context.proxyUrl, context.key);
      return result(kind, interrupted(probe), describeProbe(probe));
    }
    case "reset": {
      await context.control.install({ kind: "pass" });
      await context.toxiproxy.addReset("s3-loopback");
      const probe = await requestProbe(context.proxyUrl, context.key);
      return result(kind, interrupted(probe), describeProbe(probe));
    }
    case "http_500": {
      await context.control.install({ count: 1, key: context.key, kind });
      const probe = await requestProbe(context.proxyUrl, context.key);
      return result(kind, probe.response?.status === 500, describeProbe(probe));
    }
    case "throttle_429": {
      await context.control.install({
        count: 1,
        key: context.key,
        kind,
        retryAfterSeconds: 2,
      });
      const probe = await requestProbe(context.proxyUrl, context.key);
      const observed =
        probe.response?.status === 429 &&
        probe.response.headers.get("retry-after") === "2";
      return result(kind, observed, describeProbe(probe));
    }
    case "read_after_write": {
      await context.control.install({ count: 1, key: context.key, kind });
      await requestProbe(context.proxyUrl, context.key, {
        body: "fault-fixture",
        method: "PUT",
      });
      const probe = await requestProbe(context.proxyUrl, context.key);
      return result(kind, probe.response?.status === 404, describeProbe(probe));
    }
    case "conditional_412": {
      await context.control.install({ count: 1, key: context.key, kind });
      const probe = await requestProbe(context.proxyUrl, context.key, {
        headers: { "if-none-match": "*" },
        method: "PUT",
      });
      return result(kind, probe.response?.status === 412, describeProbe(probe));
    }
    default:
      return assertNever(kind);
  }
}

async function requestProbe(
  proxyUrl: URL,
  key: string,
  init: RequestInit = {}
): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const response = await fetch(new URL(key, proxyUrl), {
      ...init,
      signal: AbortSignal.timeout(500),
    });
    await response.arrayBuffer();
    return {
      elapsedMs: performance.now() - started,
      response,
      transportInterrupted: false,
    };
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof DOMException) {
      return {
        elapsedMs: performance.now() - started,
        response: null,
        transportInterrupted: true,
      };
    }
    throw error;
  }
}

function interrupted(probe: ProbeResult): boolean {
  return probe.transportInterrupted || probe.response?.status === 502;
}

function describeProbe(probe: ProbeResult): string {
  return `status=${probe.response?.status ?? "transport-error"};elapsedMs=${Math.round(probe.elapsedMs)}`;
}

function result(
  kind: FaultKind,
  observed: boolean,
  detail: string
): ScenarioResult {
  return Object.freeze({ detail, kind, observed });
}

function assertNever(value: never): never {
  throw new BoundaryInputError(`unhandled fault kind: ${value}`);
}
