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
});
