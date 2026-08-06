import { EventEmitter } from "node:events";
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

  it("awaits Writable backpressure and rejects asynchronous stream errors", async () => {
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
    const backpressured = new EventEmitter() as EventEmitter & {
      write(text: string, callback?: (error?: Error | null) => void): boolean;
    };
    let writeCallback: ((error?: Error | null) => void) | undefined;
    backpressured.write = (_text, callback) => {
      writeCallback = callback;
      return false;
    };
    const blocked = createRpcServerIo(readable, backpressured).write("frame\n");
    let settled = false;
    Promise.resolve(blocked).then(() => {
      settled = true;
    });
    writeCallback?.();
    await Promise.resolve();
    expect(settled).toBe(false);
    backpressured.emit("drain");
    await expect(blocked).resolves.toBeUndefined();

    const failed = new EventEmitter() as EventEmitter & {
      write(text: string, callback?: (error?: Error | null) => void): boolean;
    };
    failed.write = () => {
      queueMicrotask(() => failed.emit("error", new Error("EPIPE")));
      return true;
    };
    await expect(
      createRpcServerIo(readable, failed).write("frame\n")
    ).rejects.toThrow("EPIPE");
  });
});
