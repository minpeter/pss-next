import { describe, expect, it } from "vitest";
import { ToxiproxyClient } from "./toxiproxy-client";

describe("ToxiproxyClient", () => {
  it("uses Toxiproxy 2.12 proxy and toxic request shapes", async () => {
    // Given
    const calls: { body: unknown; method: string; url: string }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      calls.push({
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method: init?.method ?? "GET",
        url: String(input),
      });
      return Promise.resolve(Response.json([]));
    };
    const client = new ToxiproxyClient("http://127.0.0.1:18474", fetchImpl);

    // When
    await client.createProxy({
      listen: "0.0.0.0:8666",
      name: "s3-loopback",
      upstream: "localstack:4566",
    });
    await client.addLatency("s3-loopback", 125);
    await client.addTimeout("s3-loopback", 80);
    await client.addReset("s3-loopback");

    // Then
    expect(calls).toEqual([
      {
        body: {
          enabled: true,
          listen: "0.0.0.0:8666",
          name: "s3-loopback",
          upstream: "localstack:4566",
        },
        method: "POST",
        url: "http://127.0.0.1:18474/proxies",
      },
      {
        body: {
          attributes: { jitter: 0, latency: 125 },
          name: "s3-latency",
          stream: "downstream",
          toxicity: 1,
          type: "latency",
        },
        method: "POST",
        url: "http://127.0.0.1:18474/proxies/s3-loopback/toxics",
      },
      {
        body: {
          attributes: { timeout: 80 },
          name: "s3-timeout",
          stream: "downstream",
          toxicity: 1,
          type: "timeout",
        },
        method: "POST",
        url: "http://127.0.0.1:18474/proxies/s3-loopback/toxics",
      },
      {
        body: {
          attributes: { timeout: 0 },
          name: "s3-reset",
          stream: "downstream",
          toxicity: 1,
          type: "reset_peer",
        },
        method: "POST",
        url: "http://127.0.0.1:18474/proxies/s3-loopback/toxics",
      },
    ]);
  });

  it("rejects a non-loopback control endpoint", () => {
    // Given / When / Then
    expect(() => new ToxiproxyClient("http://toxiproxy:8474", fetch)).toThrow(
      "loopback"
    );
  });

  it("removes a stale proxy that owns the campaign listener", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return Promise.resolve(
        calls.length === 1
          ? Response.json({
              stale: {
                listen: "[::]:8666",
                name: "stale",
                upstream: "localstack:4566",
              },
            })
          : new Response(null, { status: 204 })
      );
    };
    const client = new ToxiproxyClient("http://127.0.0.1:18474", fetchImpl);

    await client.deleteProxiesListeningOn(8666);

    expect(calls).toEqual([
      "GET http://127.0.0.1:18474/proxies",
      "DELETE http://127.0.0.1:18474/proxies/stale",
    ]);
  });

  it("measures no remaining toxics after the proxy is deleted", async () => {
    const client = new ToxiproxyClient("http://127.0.0.1:18474", () =>
      Promise.resolve(new Response(null, { status: 404 }))
    );

    await expect(client.countToxics("deleted")).resolves.toBe(0);
  });

  it("clears a proxy that was never created", async () => {
    const client = new ToxiproxyClient("http://127.0.0.1:18474", () =>
      Promise.resolve(new Response(null, { status: 404 }))
    );

    await expect(client.clearToxics("missing")).resolves.toBeUndefined();
  });
});
