import type { TuiCommand } from "../tui/command";

export function assertNoCommandConflicts(
  existing: readonly TuiCommand[],
  incoming: readonly TuiCommand[],
  existingOwners: ReadonlyMap<string, string>,
  incomingOwner: string
): void {
  const names = new Set(
    existing
      .flatMap(({ aliases = [], name }) => [name, ...aliases])
      .map((name) => name.toLowerCase())
  );
  for (const command of incoming) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      const normalized = name.toLowerCase();
      if (names.has(normalized)) {
        const existingOwner = existingOwners.get(normalized) ?? incomingOwner;
        throw new Error(
          `Command name or alias "${name}" from extension "${incomingOwner}" conflicts with extension "${existingOwner}"`
        );
      }
      names.add(normalized);
    }
  }
}

export function assertNoKeyConflicts(
  existing: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
  existingOwners: ReadonlyMap<string, string>,
  incomingOwner: string,
  label: string
): void {
  for (const name of Object.keys(incoming)) {
    if (Object.hasOwn(existing, name)) {
      const existingOwner = existingOwners.get(name) ?? incomingOwner;
      throw new Error(
        `${label} "${name}" from extension "${incomingOwner}" conflicts with extension "${existingOwner}"`
      );
    }
  }
}

export function recordCommandOwners(
  owners: Map<string, string>,
  commands: readonly TuiCommand[],
  extensionId: string
): void {
  for (const command of commands) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      owners.set(name.toLowerCase(), extensionId);
    }
  }
}
