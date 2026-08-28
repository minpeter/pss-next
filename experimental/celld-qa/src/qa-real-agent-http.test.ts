import { describe, expect, it } from "vitest";
import {
  fetchRealAgentScenario,
  interruptRealAgentScenario,
  whileProcessLives,
} from "./qa-real-agent-http";

describe("real-agent request boundaries", () => {
  it("attaches a bounded abort signal to scenario HTTP requests", async () => {
    let observedSignal: AbortSignal | null = null;
    const fetcher: typeof fetch = (_input, init) => {
      const signal = init?.signal;
      observedSignal = signal instanceof AbortSignal ? signal : null;
      return Promise.resolve(Response.json({ passed: true }));
    };

    await expect(
      fetchRealAgentScenario(
        "http://worker",
        "attachment",
        "run",
        "token",
        fetcher
      )
    ).resolves.toEqual({ passed: true });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });

  it("requires the interruption endpoint to fail before restart", async () => {
    const completed: typeof fetch = () =>
      Promise.resolve(Response.json({ passed: true }));
    const interrupted: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 500 }));

    await expect(
      interruptRealAgentScenario(
        "http://worker",
        "tool-checkpoint",
        "token",
        completed
      )
    ).rejects.toThrow("unexpectedly completed");
    await expect(
      interruptRealAgentScenario(
        "http://worker",
        "tool-checkpoint",
        "token",
        interrupted
      )
    ).resolves.toBeUndefined();
  });

  it("fails a pending request as soon as the observed process exits", async () => {
    const exited = deferred();
    const order: string[] = [];
    const outcome = whileProcessLives(
      {},
      (_child, signal) => {
        order.push("observe");
        signal.addEventListener("abort", () => undefined, { once: true });
        return exited.promise;
      },
      () => {
        order.push("request");
        return new Promise(() => undefined);
      }
    );

    exited.resolve();
    await expect(outcome).rejects.toThrow("Celld exited");
    expect(order).toEqual(["observe", "request"]);
  });
});

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
