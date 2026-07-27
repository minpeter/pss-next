import { describe, expect, it } from "vitest";
import { runCodingAgentCli } from "./cli";
import type { CodingAgentExtensionInput } from "./extensions";

describe("configured extension startup wiring", () => {
  it("passes discovered extensions into the interactive TUI", async () => {
    // Given
    const discovered: readonly CodingAgentExtensionInput[] = [
      {
        id: "configured",
        default() {
          return;
        },
      },
    ];
    let received: readonly CodingAgentExtensionInput[] | undefined;

    // When
    const code = await runCodingAgentCli({
      argv: [],
      loadExtensions: () =>
        Promise.resolve({ extensions: discovered, notices: [] }),
      start(extensions) {
        received = extensions;
        return Promise.resolve(0);
      },
    });

    // Then
    expect(code).toBe(0);
    expect(received).toEqual(discovered);
  });
});
