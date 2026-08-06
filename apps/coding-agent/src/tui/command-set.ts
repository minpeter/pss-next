import type { TuiCommand, TuiCommandResult } from "./command";

export interface TuiCommandSet {
  commandAliasLookup: Map<string, string>;
  commandLookup: Map<string, TuiCommand>;
  commands: TuiCommand[];
}

export function buildTuiCommandSet(
  localCommands?: Iterable<TuiCommand>
): TuiCommandSet {
  const mergedCommands = new Map<string, TuiCommand>();
  const providedCommands = [...(localCommands ?? [])];

  for (const command of providedCommands) {
    mergedCommands.set(command.name.toLowerCase(), command);
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

export const createReloadCommand = (): TuiCommand => ({
  name: "reload",
  description: "Reload extensions from disk",
  execute: (): TuiCommandResult => ({
    action: { type: "reload" },
    message: "Extensions reloaded.",
    success: true,
  }),
});

export function resolveTuiCommand(
  commandSet: TuiCommandSet,
  name: string
): TuiCommand | undefined {
  const normalizedName = name.toLowerCase();
  const resolvedName =
    commandSet.commandAliasLookup.get(normalizedName) ?? normalizedName;
  return commandSet.commandLookup.get(resolvedName);
}
