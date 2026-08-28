import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FaultControlState } from "./fault-proxy-control";
import { type StartedFaultProxy, startFaultProxy } from "./fault-proxy-server";

const running: StartedFaultProxy[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

describe("fault proxy server", () => {
  it("passes requests and bodies through to the configured upstream", async () => {
    // Given
    const upstream = createServer((request, response) => {
      response.writeHead(201, { "x-upstream-method": request.method ?? "" });
      request.pipe(response);
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve)
    );
    const address = upstream.address();
    if (address === null || typeof address === "string") {
      throw new TypeError("expected TCP address");
    }
    const proxy = await startFaultProxy({
      controlPort: 0,
      dataPort: 0,
      upstreamUrl: `http://127.0.0.1:${address.port}`,
    });
    running.push(proxy);

    // When
    const response = await fetch(`${proxy.dataUrl}/bucket/key`, {
      body: "payload",
      method: "PUT",
    });

    // Then
    expect(response.status).toBe(201);
    expect(response.headers.get("x-upstream-method")).toBe("PUT");
    await expect(response.text()).resolves.toBe("payload");
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) =>
        error === undefined ? resolve() : reject(error)
      )
    );
  });

  it("matches bounded 500, 429, and conditional-write dispositions", async () => {
    // Given
    const upstream = createServer((_request, response) =>
      response.end("upstream")
    );
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve)
    );
    const address = upstream.address();
    if (address === null || typeof address === "string") {
      throw new TypeError("expected TCP address");
    }
    const state = new FaultControlState(() => 1);
    const proxy = await startFaultProxy({
      controlPort: 0,
      dataPort: 0,
      state,
      upstreamUrl: `http://127.0.0.1:${address.port}`,
    });
    running.push(proxy);

    // When
    state.install({ count: 1, key: "/bucket/key", kind: "http_500" });
    const internal = await fetch(`${proxy.dataUrl}/bucket/key`);
    const recovered = await fetch(`${proxy.dataUrl}/bucket/key`);
    state.install({
      count: 1,
      key: "/bucket/key",
      kind: "throttle_429",
      retryAfterSeconds: 7,
    });
    const throttled = await fetch(`${proxy.dataUrl}/bucket/key`);
    state.install({ count: 1, key: "/bucket/key", kind: "conditional_412" });
    const conditional = await fetch(`${proxy.dataUrl}/bucket/key`, {
      headers: { "if-none-match": "*" },
      method: "PUT",
    });

    // Then
    expect([
      internal.status,
      recovered.status,
      throttled.status,
      conditional.status,
    ]).toEqual([500, 200, 429, 412]);
    expect(throttled.headers.get("retry-after")).toBe("7");
    expect(state.events().at(-1)).toMatchObject({
      status: 412,
      synthetic: true,
      upstreamCalled: false,
    });
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) =>
        error === undefined ? resolve() : reject(error)
      )
    );
  });

  it("rejects non-loopback upstream and control addresses", async () => {
    // Given / When / Then
    await expect(
      startFaultProxy({
        controlHost: "0.0.0.0",
        controlPort: 0,
        dataPort: 0,
        upstreamUrl: "http://127.0.0.1:4566",
      })
    ).rejects.toThrow("loopback");
    await expect(
      startFaultProxy({
        controlPort: 0,
        dataPort: 0,
        upstreamUrl: "http://localstack:4566",
      })
    ).rejects.toThrow("loopback");
  });
});
