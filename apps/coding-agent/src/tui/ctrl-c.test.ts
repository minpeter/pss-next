import { describe, expect, it } from "vitest";
import { CTRL_C_EXIT_WINDOW_MS, ctrlCPressDecision } from "./ctrl-c";

describe("ctrlCPressDecision", () => {
  it("clears the composer on the first press", () => {
    expect(ctrlCPressDecision(10_000, 0)).toBe("clear");
  });

  it("exits on a second press inside the window", () => {
    expect(ctrlCPressDecision(10_000 + CTRL_C_EXIT_WINDOW_MS - 1, 10_000)).toBe(
      "exit"
    );
  });

  it("clears again once the window elapsed", () => {
    expect(ctrlCPressDecision(10_000 + CTRL_C_EXIT_WINDOW_MS, 10_000)).toBe(
      "clear"
    );
  });
});
