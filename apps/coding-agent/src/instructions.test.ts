import { describe, expect, it } from "vitest";
import {
  CODING_AGENT_INSTRUCTIONS,
  composeCodingAgentInstructions,
} from "./instructions";

describe("coding-agent instructions", () => {
  it("appends context fragments after the base instructions", () => {
    const composed = composeCodingAgentInstructions(["Project context"]);

    expect(composed).toContain(CODING_AGENT_INSTRUCTIONS);
    expect(composed.endsWith("Project context")).toBe(true);
  });
});
