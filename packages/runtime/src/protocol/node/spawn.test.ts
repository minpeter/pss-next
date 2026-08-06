import { describe, expect, it } from "vitest";
import { spawnPssClient } from "./spawn";

describe("spawnPssClient", () => {
  it("propagates spawn failures to pending requests and close", async () => {
    const client = spawnPssClient({
      command: `pss-command-that-does-not-exist-${process.pid}`,
      spawn: { stdio: ["pipe", "pipe", "pipe"] },
    });
    await expect(client.state()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(client.close()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds EOF shutdown and terminates a child that stays alive", async () => {
    const client = spawnPssClient({
      args: [
        "-e",
        "process.on('SIGTERM',()=>process.exit(0));process.stdin.resume();setInterval(()=>{},1000)",
      ],
      command: process.execPath,
      killTimeoutMs: 100,
      shutdownTimeoutMs: 20,
    });
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("closes after a child was already signal-terminated", async () => {
    const client = spawnPssClient({
      args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
      command: process.execPath,
      killTimeoutMs: 100,
      shutdownTimeoutMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("settles close when stdin fails while the child remains alive", async () => {
    const client = spawnPssClient({
      args: [
        "-e",
        "process.on('SIGTERM',()=>{});require('node:fs').closeSync(0);setInterval(()=>{},1000)",
      ],
      command: process.execPath,
      killTimeoutMs: 100,
      shutdownTimeoutMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(
      client.request("prompt", { prompt: "x".repeat(1024 * 1024) })
    ).rejects.toBeInstanceOf(Error);
    await expect(client.close()).rejects.toMatchObject({ code: "EPIPE" });
  });
});
