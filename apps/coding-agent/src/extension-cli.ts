import {
  listExtensions,
  setExtensionEnabled,
} from "./extensions/manager/activation";
import { installExtension } from "./extensions/manager/install";
import {
  removeExtension,
  updateExtensions,
} from "./extensions/manager/manager";
import type {
  ExtensionManagerContext,
  ExtensionScope,
  ListedExtension,
} from "./extensions/manager/types";

export interface RunExtensionCliOptions extends ExtensionManagerContext {
  readonly argv: readonly string[];
  readonly stdout: { write(text: string): unknown };
}

export async function runExtensionCli(
  options: RunExtensionCliOptions
): Promise<number> {
  try {
    const command = options.argv[0];
    if (command === undefined || command === "help" || command === "--help") {
      options.stdout.write(`${formatExtensionUsage()}\n`);
      return 0;
    }
    const parsed = parseArguments(options.argv.slice(1));
    const context = { ...options, scope: parsed.scope };
    switch (command) {
      case "install": {
        const source = parsed.positionals[0];
        if (source === undefined || parsed.positionals.length !== 1) {
          throw new TypeError("extension install requires exactly one source");
        }
        const entry = await installExtension({
          ...context,
          enabled: !parsed.disable,
          ...(parsed.id === undefined ? {} : { id: parsed.id }),
          source,
        });
        options.stdout.write(
          `installed ${parsed.scope} ${entry.id}${entry.enabled ? "" : " (disabled)"}\n`
        );
        return 0;
      }
      case "list": {
        const entries = await listExtensions({
          ...options,
          ...(parsed.scopeExplicit ? { scope: parsed.scope } : {}),
        });
        options.stdout.write(formatExtensionList(entries));
        return 0;
      }
      case "remove": {
        const id = requireSingleId(parsed.positionals, "remove");
        const entry = await removeExtension({ ...context, id });
        options.stdout.write(`removed ${parsed.scope} ${entry.id}\n`);
        return 0;
      }
      case "update": {
        const entries = await updateExtensions({
          ...context,
          all: parsed.all,
          ids: parsed.positionals,
        });
        writeAffected(options.stdout, "updated", parsed.scope, entries);
        return 0;
      }
      case "enable":
      case "disable": {
        const enabled = command === "enable";
        const entries = await setExtensionEnabled({
          ...context,
          all: parsed.all,
          enabled,
          ids: parsed.positionals,
        });
        writeAffected(
          options.stdout,
          enabled ? "enabled" : "disabled",
          parsed.scope,
          entries
        );
        return 0;
      }
      default:
        throw new TypeError(`Unknown extension command: ${command}`);
    }
  } catch (error) {
    options.stdout.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

export function formatExtensionUsage(): string {
  return [
    "Usage: pss extension <command>",
    "",
    "Commands:",
    "  install <source> [--scope global|project] [--id <id>] [--disable]",
    "  list [--scope global|project]",
    "  remove <id> [--scope global|project]",
    "  update [id ...] [--all] [--scope global|project]",
    "  enable <id ...>|--all [--scope global|project]",
    "  disable <id ...>|--all [--scope global|project]",
  ].join("\n");
}

interface ParsedArguments {
  readonly all: boolean;
  readonly disable: boolean;
  readonly id?: string;
  readonly positionals: readonly string[];
  readonly scope: ExtensionScope;
  readonly scopeExplicit: boolean;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  let all = false;
  let disable = false;
  let id: string | undefined;
  let scope: ExtensionScope = "global";
  let scopeExplicit = false;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (value === "--all") {
      all = true;
      continue;
    }
    if (value === "--disable") {
      disable = true;
      continue;
    }
    if (value === "--id") {
      id = requireFlagValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === "--scope") {
      const scopeValue = requireFlagValue(argv, index, value);
      if (scopeValue !== "global" && scopeValue !== "project") {
        throw new TypeError(`Invalid extension scope: ${scopeValue}`);
      }
      scope = scopeValue;
      scopeExplicit = true;
      index += 1;
      continue;
    }
    if (value.startsWith("--")) {
      throw new TypeError(`Unknown extension option: ${value}`);
    }
    positionals.push(value);
  }
  return {
    all,
    disable,
    ...(id === undefined ? {} : { id }),
    positionals,
    scope,
    scopeExplicit,
  };
}

function requireFlagValue(
  argv: readonly string[],
  index: number,
  flag: string
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value`);
  }
  return value;
}

function requireSingleId(
  positionals: readonly string[],
  command: string
): string {
  const id = positionals[0];
  if (id === undefined || positionals.length !== 1) {
    throw new TypeError(`extension ${command} requires exactly one id`);
  }
  return id;
}

function formatExtensionList(entries: readonly ListedExtension[]): string {
  if (entries.length === 0) {
    return "No extensions installed.\n";
  }
  return `${entries
    .map(
      (entry) =>
        `${entry.scope.padEnd(7)}  ${entry.status.padEnd(8)} ${entry.id}  ${entry.source}`
    )
    .join("\n")}\n`;
}

function writeAffected(
  stdout: { write(text: string): unknown },
  action: string,
  scope: ExtensionScope,
  entries: readonly { readonly id: string }[]
): void {
  for (const entry of entries) {
    stdout.write(`${action} ${scope} ${entry.id}\n`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
