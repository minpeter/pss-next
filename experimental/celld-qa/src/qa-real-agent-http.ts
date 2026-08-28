import type { ChildProcess } from "node:child_process";

const REQUEST_TIMEOUT_MS = 30_000;

type Fetcher = typeof fetch;

export async function fetchRealAgentScenario(
  baseUrl: string,
  scenario: string,
  phase: string,
  token: string,
  fetcher: Fetcher = fetch
): Promise<unknown> {
  const response = await fetcher(scenarioUrl(baseUrl, scenario, token), {
    body: JSON.stringify({ phase, scenario, token }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    throw new TypeError(
      `Real-agent scenario failed with HTTP ${response.status}.`
    );
  }
  return value;
}

export async function interruptRealAgentScenario(
  baseUrl: string,
  scenario: string,
  token: string,
  fetcher: Fetcher = fetch
): Promise<void> {
  const response = await fetcher(scenarioUrl(baseUrl, scenario, token), {
    body: JSON.stringify({ phase: "interrupt", scenario, token }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok) {
    throw new TypeError(
      "Interrupted real-agent scenario unexpectedly completed."
    );
  }
}

export async function whileProcessLives<TChild, TResult>(
  child: TChild,
  waitForExit: (child: TChild, signal: AbortSignal) => Promise<void>,
  request: () => Promise<TResult>
): Promise<TResult> {
  const observer = new AbortController();
  const exited = waitForExit(child, observer.signal).then(() => {
    throw new Error("Celld exited during a real-agent request.");
  });
  try {
    return await Promise.race([request(), exited]);
  } finally {
    observer.abort();
  }
}

export function waitForChildProcessExit(
  child: ChildProcess,
  signal: AbortSignal
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    const onExit = (): void => {
      cleanup();
      resolve();
    };
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function scenarioUrl(baseUrl: string, scenario: string, token: string): string {
  const object = encodeURIComponent(`${scenario}:${token}`);
  return `${baseUrl}/real-agent?object=${object}`;
}
