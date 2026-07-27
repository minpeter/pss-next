import { describe, expect, it } from "vitest";
import { defaultSpawnInstall } from "./install";

describe("defaultSpawnInstall", () => {
  it("returns a nonzero exit instead of rejecting when spawn fails", async () => {
    await expect(
      defaultSpawnInstall("pss-command-that-does-not-exist", [])
    ).resolves.toBe(1);
  });
});
