import { describe, expect, it } from "vitest";
import type { TuiCommand } from "./command";
import { buildTuiCommandSet, resolveTuiCommand } from "./command-set";

describe("buildTuiCommandSet", () => {
  it("keeps only the provided commands without injecting /help", () => {
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

    expect(commandSet.commands.map((command) => command.name)).toEqual(["new"]);
    expect(commandSet.commandLookup.has("help")).toBe(false);
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
        aliases: ["clear"],
        description: "Reload extensions",
        execute: () => ({ success: true }),
        name: "reload",
      },
      {
        description: "Start a new session",
        execute: () => ({ success: true }),
        name: "clear",
      },
    ]);

    expect(commandSet.commandAliasLookup.has("clear")).toBe(false);
    expect(commandSet.commandLookup.get("clear")?.description).toBe(
      "Start a new session"
    );
  });

  it("derives active-turn eligibility from resolved command metadata", () => {
    const commandSet = buildTuiCommandSet([
      {
        aliases: ["shrink"],
        allowDuringActiveTurn: true,
        description: "Compact context",
        execute: () => ({ success: true }),
        name: "compact",
      },
      {
        description: "Rename",
        execute: () => ({ success: true }),
        name: "name",
      },
    ]);

    expect(resolveTuiCommand(commandSet, "SHRINK")?.allowDuringActiveTurn).toBe(
      true
    );
    expect(
      resolveTuiCommand(commandSet, "name")?.allowDuringActiveTurn
    ).not.toBe(true);
  });
});
