import { describe, expect, it, vi } from "vitest";
import type { RequestDecisionEvent } from "./fault-proxy-types";
import { runFaultScenario } from "./s3-fault-scenario";

describe("live Celld S3 fault scenario", () => {
  it("requires injected evidence and two exactly-once recovery reads", async () => {
    const deactivate = vi.fn().mockResolvedValue(undefined);
    const requests = [
      {
        commitCount: null,
        elapsedMs: 130,
        ok: false,
        reply: null,
        status: 500,
      },
      {
        commitCount: 1,
        elapsedMs: 5,
        ok: true,
        reply: "echo:fault-latency",
        status: 200,
      },
      {
        commitCount: 1,
        elapsedMs: 5,
        ok: true,
        reply: "echo:fault-latency",
        status: 200,
      },
    ];
    const event: RequestDecisionEvent = {
      error: null,
      generation: 7,
      key: "/bucket/run-cell",
      method: "GET",
      status: 200,
      synthetic: false,
      upstreamCalled: true,
    };

    const result = await runFaultScenario("latency", {
      activate: () => Promise.resolve(7),
      deactivate,
      events: () => Promise.resolve([event]),
      request: () => Promise.resolve(requests.shift() ?? requests[0]),
    });

    expect(deactivate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      convergence: true,
      effect: "exactly_once",
      injectionEvidence: true,
      observed: true,
      recovery: true,
    });
  });

  it("performs the read-after-write probe before clearing the fault", async () => {
    const order: string[] = [];
    const request = vi.fn().mockImplementation(() => {
      order.push("request");
      return Promise.resolve({
        commitCount: 1,
        elapsedMs: 5,
        ok: true,
        reply: "echo:fault-read_after_write",
        status: 200,
      });
    });

    await runFaultScenario("read_after_write", {
      activate: () => Promise.resolve(9),
      deactivate: () => {
        order.push("deactivate");
        return Promise.resolve();
      },
      events: () =>
        Promise.resolve([
          {
            error: null,
            generation: 9,
            key: "/bucket/run-cell",
            method: "GET",
            status: 404,
            synthetic: true,
            upstreamCalled: false,
          },
        ]),
      request,
    });

    expect(request).toHaveBeenCalledTimes(4);
    expect(order).toEqual([
      "request",
      "request",
      "deactivate",
      "request",
      "request",
    ]);
  });
});
