import { describe, expect, it } from "vitest";
import {
  buildAliasToCanonicalNameMap,
  createAliasAwareAutocompleteProvider,
} from "./autocomplete";

describe("createAliasAwareAutocompleteProvider", () => {
  it("offers slash-command completions after leading whitespace", async () => {
    const provider = createAliasAwareAutocompleteProvider({
      commands: [
        {
          description: "Show help",
          execute: () => ({ success: true }),
          name: "help",
        },
      ],
    });

    await expect(
      provider.getSuggestions(["  /he"], 0, 5, {
        force: false,
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({
      items: [{ value: "help" }],
    });
  });

  it("does not treat canonical command names as aliases", () => {
    const aliases = buildAliasToCanonicalNameMap([
      {
        aliases: ["help"],
        description: "Start a new session",
        execute: () => ({ success: true }),
        name: "new",
      },
      {
        description: "Show help",
        execute: () => ({ success: true }),
        name: "help",
      },
    ]);

    expect(aliases.has("help")).toBe(false);
  });
});
