import { describe, expect, it } from "vitest";
import { PssProtocolClient } from "./client";
import { servePssProtocol } from "./server";

async function* chunks(...values: string[]): AsyncIterable<string> {
  await Promise.resolve();
  for (const value of values) {
    yield value;
  }
}

describe("PSS protocol", () => {
  it("reports framing and handler errors without contaminating frames", async () => {
    const output: string[] = [];
    await servePssProtocol(
      {
        readable: chunks(
          'bad\n{"jsonrpc":"2.0","protocol":"pss/1","id":1,"method":"state"}\n{"jsonrpc":"2.0","protocol":"pss/1","id":2,"method":"prompt","params":{}}\n'
        ),
        write: (text) => {
          output.push(text);
        },
      },
      {
        handle(method) {
          if (method === "prompt") {
            throw new Error("boom");
          }
          return { status: "idle" };
        },
      }
    );
    const messages = output.map((line) => JSON.parse(line));
    expect(messages).toMatchObject([
      { error: { code: -32_700 }, id: null },
      { id: 1, result: { status: "idle" } },
      { error: { code: -32_603, message: "boom" }, id: 2 },
    ]);
  });

  it("correlates concurrent responses, events, and RPC errors", async () => {
    const writes: string[] = [];
    let feed: ((value: string | null) => void) | undefined;
    const readable = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<string>>((resolve) => {
              feed = (value) =>
                resolve(
                  value === null
                    ? { done: true, value: undefined }
                    : { done: false, value }
                );
            }),
        };
      },
    };
    const client = new PssProtocolClient({
      readable,
      write: (line) => {
        writes.push(line);
      },
    });
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));
    const state = client.state();
    const abort = client.abort();
    await Promise.resolve();
    feed?.(
      '{"jsonrpc":"2.0","protocol":"pss/1","id":2,"error":{"code":-32000,"message":"no turn"}}\n'
    );
    await Promise.resolve();
    feed?.(
      '{"jsonrpc":"2.0","protocol":"pss/1","method":"event","params":{"event":{"type":"tick"},"requestId":1}}\n{"jsonrpc":"2.0","protocol":"pss/1","id":1,"result":{"status":"idle"}}\n'
    );
    await expect(abort).rejects.toMatchObject({ code: -32_000 });
    await expect(state).resolves.toEqual({ status: "idle" });
    expect(events).toEqual([{ event: { type: "tick" }, requestId: 1 }]);
    expect(writes).toHaveLength(2);
    feed?.(null);
  });

  it("turns synchronous transport write failures into request rejections and recovers", async () => {
    let feed: ((value: string | null) => void) | undefined;
    const readable = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<string>>((resolve) => {
              feed = (value) =>
                resolve(
                  value === null
                    ? { done: true, value: undefined }
                    : { done: false, value }
                );
            }),
        };
      },
    };
    let writes = 0;
    const client = new PssProtocolClient({
      readable,
      write() {
        writes += 1;
        if (writes === 1) {
          throw new Error("synchronous write failure");
        }
      },
    });

    let first: Promise<unknown> | undefined;
    expect(() => {
      first = client.state();
    }).not.toThrow();
    await expect(first).rejects.toThrow("synchronous write failure");

    const second = client.state();
    await Promise.resolve();
    feed?.(
      '{"jsonrpc":"2.0","protocol":"pss/1","id":2,"result":{"activeRequestId":null,"status":"idle"}}\n'
    );
    await expect(second).resolves.toMatchObject({ status: "idle" });
    feed?.(null);
  });

  it("isolates event listener exceptions from responses", async () => {
    const errors: unknown[] = [];
    const client = new PssProtocolClient({
      readable: chunks(
        '{"jsonrpc":"2.0","protocol":"pss/1","method":"event","params":{"event":{"type":"tick"}}}\n{"jsonrpc":"2.0","protocol":"pss/1","id":1,"result":{"activeRequestId":null,"status":"idle"}}\n'
      ),
      write: () => undefined,
    });
    client.onEvent(() => {
      throw new Error("listener failed");
    });
    client.onEventError((error) => errors.push(error));
    await expect(client.state()).resolves.toMatchObject({ status: "idle" });
    expect(errors).toHaveLength(1);
  });

  it("closes without waiting forever when transport has no close", async () => {
    let returned = false;
    const client = new PssProtocolClient({
      readable: {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<string>>(() => undefined),
            return: () => {
              returned = true;
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
      write: () => undefined,
    });
    await client.close();
    expect(returned).toBe(true);
  });

  it("rejects invalid failure codes and unsafe response ids", async () => {
    const client = new PssProtocolClient({
      readable: chunks(
        '{"jsonrpc":"2.0","protocol":"pss/1","id":1,"error":{"code":1.5,"message":"bad"}}\n'
      ),
      write: () => undefined,
    });
    await expect(client.state()).rejects.toThrow("Invalid PSS protocol error");
  });

  it("normalizes undefined and non-JSON handler results to errors", async () => {
    const output: string[] = [];
    await servePssProtocol(
      {
        readable: chunks(
          '{"jsonrpc":"2.0","protocol":"pss/1","id":1,"method":"state"}\n{"jsonrpc":"2.0","protocol":"pss/1","id":2,"method":"state"}\n'
        ),
        write: (frame) => {
          output.push(frame);
        },
      },
      {
        handle(_method, _params, context) {
          return context.requestId === 1 ? undefined : { bad: undefined };
        },
      }
    );
    expect(output.map((frame) => JSON.parse(frame))).toMatchObject([
      { error: { code: -32_603 }, id: 1 },
      { error: { code: -32_603 }, id: 2 },
    ]);
  });

  it("awaits deferred work and its late event writes at EOF", async () => {
    const output: string[] = [];
    await servePssProtocol(
      {
        readable: chunks(
          '{"jsonrpc":"2.0","protocol":"pss/1","id":1,"method":"prompt"}\n'
        ),
        write: (frame) => {
          output.push(frame);
        },
      },
      {
        handle(_method, _params, context) {
          context.defer?.(
            Promise.resolve().then(() => context.emit({ type: "late" }))
          );
          return { accepted: true };
        },
      }
    );
    expect(output.map((frame) => JSON.parse(frame))).toHaveLength(2);
    expect(output.join("")).toContain('"type":"late"');
  });

  it("fails closed after a transport write rejection", async () => {
    let attempts = 0;
    await expect(
      servePssProtocol(
        {
          readable: chunks(
            '{"jsonrpc":"2.0","protocol":"pss/1","id":1,"method":"state"}\n{"jsonrpc":"2.0","protocol":"pss/1","id":2,"method":"state"}\n'
          ),
          write() {
            attempts += 1;
            return Promise.reject(new Error("transport dead"));
          },
        },
        { handle: () => ({ status: "idle" }) }
      )
    ).rejects.toThrow("transport dead");
    expect(attempts).toBe(1);
  });

  it("rejects unsafe numeric request ids", async () => {
    const output: string[] = [];
    await servePssProtocol(
      {
        readable: chunks(
          '{"jsonrpc":"2.0","protocol":"pss/1","id":9007199254740992,"method":"state"}\n'
        ),
        write: (frame) => {
          output.push(frame);
        },
      },
      { handle: () => ({ status: "idle" }) }
    );
    expect(JSON.parse(output[0] ?? "null")).toMatchObject({
      error: { code: -32_600 },
      id: null,
    });
  });

  it("rejects requests after close and cancels request-close races", async () => {
    let writes = 0;
    const client = new PssProtocolClient({
      readable: {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<string>>(() => undefined),
            return: () => Promise.resolve({ done: true, value: undefined }),
          };
        },
      },
      write() {
        writes += 1;
      },
    });
    const racing = client.state();
    await client.close();
    await expect(racing).rejects.toThrow("closed");
    await expect(client.state()).rejects.toThrow("closed");
    expect(writes).toBe(0);
  });

  it("observes deferred rejections while input remains open", async () => {
    let feed: ((value: string | null) => void) | undefined;
    const readable = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<string>>((resolve) => {
              feed = (value) =>
                resolve(
                  value === null
                    ? { done: true, value: undefined }
                    : { done: false, value }
                );
            }),
        };
      },
    };
    const serving = servePssProtocol(
      { readable, write: () => undefined },
      {
        handle(_method, _params, context) {
          context.defer?.(Promise.reject(new Error("background failed")));
          return { accepted: true };
        },
      }
    );
    feed?.('{"jsonrpc":"2.0","protocol":"pss/1","id":1,"method":"prompt"}\n');
    await new Promise((resolve) => setTimeout(resolve, 0));
    feed?.(null);
    await expect(serving).resolves.toBeUndefined();
  });

  it("observes write-tail rejection while input remains open", async () => {
    let feed: ((value: string | null) => void) | undefined;
    const readable = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<string>>((resolve) => {
              feed = (value) =>
                resolve(
                  value === null
                    ? { done: true, value: undefined }
                    : { done: false, value }
                );
            }),
        };
      },
    };
    const serving = servePssProtocol(
      {
        readable,
        write: () => Promise.reject(new Error("open transport failed")),
      },
      { handle: () => ({ status: "idle" }) }
    );
    feed?.('{"jsonrpc":"2.0","protocol":"pss/1","id":1,"method":"state"}\n');
    await new Promise((resolve) => setTimeout(resolve, 0));
    feed?.(null);
    await expect(serving).rejects.toThrow("open transport failed");
  });

  it("does not write a deferred request after readable EOF", async () => {
    let writes = 0;
    const client = new PssProtocolClient({
      readable: {
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.resolve({ done: true, value: undefined }),
          };
        },
      },
      write() {
        writes += 1;
      },
    });
    await expect(client.state()).rejects.toThrow("transport closed");
    expect(writes).toBe(0);
  });

  it("observes concurrent operation rejection after the write tail dies", async () => {
    let feed: ((value: string | null) => void) | undefined;
    const readable = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<string>>((resolve) => {
              feed = (value) =>
                resolve(
                  value === null
                    ? { done: true, value: undefined }
                    : { done: false, value }
                );
            }),
        };
      },
    };
    const serving = servePssProtocol(
      {
        readable,
        write: () => Promise.reject(new Error("write tail died")),
      },
      {
        async handle(_method, _params, context) {
          if (context.requestId === 2) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return { status: "idle" };
        },
      }
    );
    feed?.(
      '{"jsonrpc":"2.0","protocol":"pss/1","id":1,"method":"state"}\n{"jsonrpc":"2.0","protocol":"pss/1","id":2,"method":"state"}\n'
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    feed?.(null);
    await expect(serving).rejects.toThrow("write tail died");
  });

  it("serializes concurrent outbound writes with backpressure", async () => {
    let feed: ((value: string | null) => void) | undefined;
    const readable = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<string>>((resolve) => {
              feed = (value) =>
                resolve(
                  value === null
                    ? { done: true, value: undefined }
                    : { done: false, value }
                );
            }),
        };
      },
    };
    let releaseFirst: (() => void) | undefined;
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const methods: string[] = [];
    const client = new PssProtocolClient({
      readable,
      async write(frame) {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        methods.push(JSON.parse(frame).method);
        if (methods.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        activeWrites -= 1;
      },
    });
    const state = client.state();
    const abort = client.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(methods).toEqual(["state"]);
    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(methods).toEqual(["state", "abort"]);
    expect(maximumActiveWrites).toBe(1);
    feed?.(
      '{"jsonrpc":"2.0","protocol":"pss/1","id":1,"result":{"activeRequestId":null,"status":"idle"}}\n{"jsonrpc":"2.0","protocol":"pss/1","id":2,"result":{"interrupted":false}}\n'
    );
    await expect(state).resolves.toMatchObject({ status: "idle" });
    await expect(abort).resolves.toEqual({ interrupted: false });
    feed?.(null);
  });

  it("dispatches valid frames before failing on a malformed neighbor consistently", async () => {
    const response =
      '{"jsonrpc":"2.0","protocol":"pss/1","id":1,"result":{"activeRequestId":null,"status":"idle"}}\n';
    const run = async (input: readonly string[]) => {
      const client = new PssProtocolClient({
        readable: chunks(...input),
        write: () => undefined,
      });
      const first = await client.state();
      await Promise.resolve();
      const secondError = await client.state().then(
        () => "resolved",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error)
      );
      return { first, secondError };
    };
    const sameChunk = await run([`${response}malformed\n`]);
    const splitChunks = await run([response, "malformed\n"]);
    expect(sameChunk.first).toMatchObject({ status: "idle" });
    expect(sameChunk.secondError).toContain("Invalid JSONL frame");
    expect(splitChunks).toEqual(sameChunk);
  });
});
