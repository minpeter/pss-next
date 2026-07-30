import { describe, expect, it } from "vitest";
import { normalizedColorLines, normalizedLines } from "./utils";

const ESC = "\x1b";

describe("normalizedColorLines", () => {
  it("keeps SGR sequences that normalizedLines escapes", () => {
    const input = `${ESC}[32mok${ESC}[0m`;

    expect(normalizedLines(input)).toEqual(["^[[32mok^[[0m"]);
    expect(normalizedColorLines(input)).toEqual([input]);
  });

  it("still neutralizes cursor control while splitting lines", () => {
    expect(normalizedColorLines(`a${ESC}[2J\nb`)).toEqual(["a^[[2J", "b"]);
  });
});
