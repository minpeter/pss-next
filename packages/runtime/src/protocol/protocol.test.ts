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
});
