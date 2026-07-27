import type { TuiCommand, TuiCommandResult } from "./command";

export interface TuiCommandSet {
  commandAliasLookup: Map<string, string>;
  commandLookup: Map<string, TuiCommand>;
  commands: TuiCommand[];
}

const formatHelpLine = (command: TuiCommand): string => {
  const aliases = command.aliases ?? [];
  const aliasSuffix = aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
  return `/${command.name}${aliasSuffix} - ${command.description}`;
};

const createHelpCommand = (
  getCommands: () => Iterable<TuiCommand>
): TuiCommand => ({
  name: "help",
  description: "Show available commands",
  execute: (): TuiCommandResult => {
    const lines = [...getCommands()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(formatHelpLine);
    return {
      success: true,
      message: ["Available commands:", ...lines].join("\n"),
    };
  },
});

export function buildTuiCommandSet(
  localCommands?: Iterable<TuiCommand>
): TuiCommandSet {
  const mergedCommands = new Map<string, TuiCommand>();
  const providedCommands = [...(localCommands ?? [])];

  for (const command of providedCommands) {
    mergedCommands.set(command.name.toLowerCase(), command);
  }

  const hasCustomHelp = providedCommands.some(
    (command) => command.name.toLowerCase() === "help"
  );
  if (!hasCustomHelp) {
    mergedCommands.set(
      "help",
      createHelpCommand(() => mergedCommands.values())
    );
  }

  const commandAliasLookup = new Map<string, string>();
  for (const command of mergedCommands.values()) {
    const normalizedName = command.name.toLowerCase();
    for (const alias of command.aliases ?? []) {
      const normalizedAlias = alias.toLowerCase();
      if (
        normalizedAlias !== normalizedName &&
        !mergedCommands.has(normalizedAlias)
      ) {
        commandAliasLookup.set(normalizedAlias, normalizedName);
      }
    }
  }

  return {
    commandAliasLookup,
    commandLookup: mergedCommands,
    commands: [...mergedCommands.values()],
  };
}

const newSessionAction = (): TuiCommandResult => ({
  success: true,
  action: { type: "new-session" },
});

export const createClearCommand = (): TuiCommand => ({
  name: "clear",
  displayName: "clear (new)",
  aliases: ["new"],
  description: "Start a new session",
  execute: () => newSessionAction(),
});

export const createReloadCommand = (): TuiCommand => ({
  name: "reload",
  description: "Reload extensions from disk",
  execute: (): TuiCommandResult => ({
    action: { type: "reload" },
    message: "Extensions reloaded.",
    success: true,
  }),
});
