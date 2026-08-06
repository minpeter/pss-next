import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRpcThreadConfig } from "./rpc-cli";

describe("RPC CLI thread config", () => {
  it("uses the caller-provided isolated home", () => {
    const home = "/isolated/rpc-home";
    const config = resolveRpcThreadConfig({}, "/workspace", home);
    expect(config.directory).toBe(join(home, ".pss", "threads"));
  });
});
