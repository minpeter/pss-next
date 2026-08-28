import { createServer, request as httpRequest, type Server } from "node:http";
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

  it("does not allow an absolute-form target to escape the upstream", async () => {
    // Given
    let configuredCalls = 0;
    let escapedCalls = 0;
    const configured = createServer((_request, response) => {
      configuredCalls += 1;
      response.end("configured");
    });
    const escaped = createServer((_request, response) => {
      escapedCalls += 1;
      response.end("escaped");
    });
    const configuredPort = await listenOnRandomPort(configured);
    const escapedPort = await listenOnRandomPort(escaped);
    const proxy = await startFaultProxy({
      controlPort: 0,
      dataPort: 0,
      upstreamUrl: `http://127.0.0.1:${configuredPort}`,
    });
    running.push(proxy);
    const proxyPort = new URL(proxy.dataUrl).port;

    // When
    const status = await requestStatus(
      Number(proxyPort),
      `http://127.0.0.1:${escapedPort}/foreign`
    );

    // Then
    expect(status).toBe(400);
    expect(configuredCalls).toBe(0);
    expect(escapedCalls).toBe(0);
    await Promise.all([closeServer(configured), closeServer(escaped)]);
  });

  it("records one decision when the upstream fails after headers", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      response.destroy(new Error("mid-stream reset"));
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    const state = new FaultControlState(() => 1);
    const proxy = await startFaultProxy({
      controlPort: 0,
      dataPort: 0,
      state,
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    running.push(proxy);

    await expect(
      fetch(`${proxy.dataUrl}/bucket/key`).then((response) => response.text())
    ).rejects.toThrow();
    expect(state.events()).toHaveLength(1);
    expect(state.events()[0]?.error).not.toBeNull();

    await closeServer(upstream);
  });

  it("closes the data listener when the control listener cannot start", async () => {
    // Given
    const blocker = createServer();
    const controlPort = await listenOnRandomPort(blocker);
    const reservation = createServer();
    const dataPort = await listenOnRandomPort(reservation);
    await closeServer(reservation);

    // When
    await expect(
      startFaultProxy({
        controlPort,
        dataPort,
        upstreamUrl: "http://127.0.0.1:4566",
      })
    ).rejects.toThrow();

    // Then
    const replacement = createServer();
    await listen(replacement, dataPort);
    await Promise.all([closeServer(replacement), closeServer(blocker)]);
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

function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new TypeError("expected TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function requestStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", path, port },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      }
    );
    request.once("error", reject);
    request.end();
  });
}
