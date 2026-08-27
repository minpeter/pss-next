import { describe, expect, it } from "vitest";
import { runNativeQa } from "./qa-native";

describe("Celld QA contract", () => {
  it("returns the persistent echo contract for two requests", async () => {
    const result = await runNativeQa({
      baseUrl: "http://127.0.0.1:16420",
      fetchImpl: async () =>
        Response.json(
          callCount++ === 0
            ? { historyCount: 1, ok: true, reply: "echo:hello" }
            : { historyCount: 2, ok: true, reply: "echo:hello" }
        ),
      objectName: "pss-smoke",
      text: "hello",
    });

    expect(result).toEqual({
      first: { historyCount: 1, ok: true, reply: "echo:hello" },
      second: { historyCount: 2, ok: true, reply: "echo:hello" },
    });
  });
});

let callCount = 0;
