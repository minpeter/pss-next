import { describe, expect, it } from "vitest";
import { mergeToolRenderers } from "./app";

describe("TUI extension renderer merging", () => {
  it("attributes built-in renderer collisions to the extension", () => {
    const builtIn = { shell_execute: () => undefined };
    const contributed = { shell_execute: () => undefined };

    expect(() =>
      mergeToolRenderers(builtIn, contributed, () => "renderer-provider")
    ).toThrow(
      'Extension "renderer-provider" tool renderer "shell_execute" conflicts with built-in renderer'
    );
  });
});
