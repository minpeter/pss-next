import { describe, expect, it } from "vitest";
import { shouldReplayOnStartup } from "./session-startup-replay";

describe("shouldReplayOnStartup", () => {
  it("replays when the startup session was explicitly selected", () => {
    expect(shouldReplayOnStartup({ resumedExplicitly: true })).toBe(true);
  });

  it("does not replay a fresh startup session", () => {
    expect(shouldReplayOnStartup({ resumedExplicitly: false })).toBe(false);
  });
});
