import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRpcServerIo, resolveRpcThreadConfig } from "./rpc-cli";

describe("RPC CLI thread config", () => {
  it("uses the caller-provided isolated home", () => {
    const home = "/isolated/rpc-home";
    const config = resolveRpcThreadConfig({}, "/workspace", home);
    expect(config.directory).toBe(join(home, ".pss", "threads"));
  });

  it("captures injected stdout and propagates asynchronous write rejection", async () => {
    const frames: string[] = [];
    const readable = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            Promise.resolve<IteratorResult<string>>({
              done: true,
              value: undefined,
            }),
        };
      },
    };
    const io = createRpcServerIo(readable, {
      write(text) {
        frames.push(text);
        return Promise.resolve();
      },
    });
    await expect(io.write("frame\n")).resolves.toBeUndefined();
    expect(frames).toEqual(["frame\n"]);

    const rejected = createRpcServerIo(readable, {
      write: () => Promise.reject(new Error("stdout failed")),
    });
    await expect(rejected.write("frame\n")).rejects.toThrow("stdout failed");
  });
});
