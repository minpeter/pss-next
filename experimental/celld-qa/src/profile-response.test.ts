import { describe, expect, it } from "vitest";
import { isCorrectProfileResponse } from "./profile-response";

describe("profile response correctness", () => {
  it("requires the exact reply and durable positive counts", () => {
    expect(
      isCorrectProfileResponse(
        {
          commitCount: 2,
          historyCount: 2,
          ok: true,
          reply: "echo:profile-7",
        },
        "profile-7"
      )
    ).toBe(true);
    expect(
      isCorrectProfileResponse(
        {
          commitCount: 2,
          historyCount: 2,
          ok: true,
          reply: "wrong",
        },
        "profile-7"
      )
    ).toBe(false);
    expect(isCorrectProfileResponse({ ok: true }, "profile-7")).toBe(false);
  });
});
