import { describe, expect, it } from "vitest";
import type { TuiCommand } from "./command";
import { buildTuiCommandSet } from "./command-set";

describe("buildTuiCommandSet", () => {
  it("merges local commands with global help for autocomplete and execution", async () => {
    const localCommands: TuiCommand[] = [
      {
        name: "new",
        aliases: ["clear", "reset"],
        description: "Start a new session",
        execute: () => ({
          success: true,
          action: { type: "new-session" },
        }),
      },
    ];

    const commandSet = buildTuiCommandSet(localCommands);

    expect(commandSet.commands.some((command) => command.name === "help")).toBe(
      true
    );
    expect(commandSet.commands.some((command) => command.name === "new")).toBe(
      true
    );

    const helpCommand = commandSet.commandLookup.get("help");
    const result = await helpCommand?.execute({ args: [] });

    expect(result?.success).toBe(true);
    expect(result?.message).toContain("/help - Show available commands");
    expect(result?.message).toContain(
      "/new (clear, reset) - Start a new session"
    );
  });

  it("preserves a custom local help command instead of overwriting it", async () => {
    const localHelp: TuiCommand = {
      name: "help",
      description: "Custom help",
      execute: () => ({
        success: true,
        message: "custom help",
      }),
    };

    const commandSet = buildTuiCommandSet([localHelp]);
    const helpCommand = commandSet.commandLookup.get("help");
    const result = await helpCommand?.execute({ args: [] });

    expect(result?.message).toBe("custom help");
  });

  it("resolves aliases to the canonical command name", () => {
    const commandSet = buildTuiCommandSet([
      {
        name: "clear",
        aliases: ["new"],
        description: "Start a new session",
        execute: () => ({ success: true }),
      },
    ]);

    expect(commandSet.commandAliasLookup.get("new")).toBe("clear");
    expect(commandSet.commandLookup.get("clear")?.description).toBe(
      "Start a new session"
    );
  });

  it("does not let an alias shadow a canonical command", () => {
    const commandSet = buildTuiCommandSet([
      {
        aliases: ["help"],
        description: "Start a new session",
        execute: () => ({ success: true }),
        name: "new",
      },
    ]);

    expect(commandSet.commandAliasLookup.has("help")).toBe(false);
    expect(commandSet.commandLookup.get("help")?.description).toBe(
      "Show available commands"
    );
  });
});
