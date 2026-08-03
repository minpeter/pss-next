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

  it("refreshes argument completions after its query is erased", async () => {
    const provider = createAliasAwareAutocompleteProvider({
      commands: [
        {
          description: "Pick a model",
          execute: () => ({ success: true }),
          getArgumentCompletions: async () => [
            { label: "mimo-v2.5-free", value: "mimo-v2.5-free" },
          ],
          name: "model",
        },
      ],
    });
    const options = { force: false, signal: new AbortController().signal };

    await expect(
      provider.getSuggestions(["/model mi"], 0, 9, options)
    ).resolves.toMatchObject({
      items: [{ value: "mimo-v2.5-free" }],
      prefix: "mi",
    });
    await expect(
      provider.getSuggestions(["/model "], 0, 7, options)
    ).resolves.toMatchObject({
      items: [{ value: "mimo-v2.5-free" }],
      prefix: "",
    });
  });

  it("keeps argument completions closed after erasing a query", async () => {
    const sessions = [
      { label: "untitled  #aaaaaaaa", value: "#aaaaaaaa" },
      { label: "test-ek   #bbbbbbbb", value: "test-ek" },
    ];
    const provider = createAliasAwareAutocompleteProvider({
      commands: [
        {
          description: "Resume a session",
          execute: () => ({ success: true }),
          getArgumentCompletions: async (query) =>
            query.length === 0
              ? null
              : sessions.filter(({ label }) =>
                  label.toLowerCase().includes(query.toLowerCase())
                ),
          name: "resume",
        },
      ],
    });
    const options = { force: false, signal: new AbortController().signal };

    await expect(
      provider.getSuggestions(["/resume tes"], 0, 11, options)
    ).resolves.toMatchObject({
      items: [{ value: "test-ek" }],
      prefix: "tes",
    });
    await expect(
      provider.getSuggestions(["/resume "], 0, 8, options)
    ).resolves.toBeNull();
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
