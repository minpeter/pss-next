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
});
