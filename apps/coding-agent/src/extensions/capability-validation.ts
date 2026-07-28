import { isAbsolute } from "node:path";
import type { ThreadStateMigration } from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import type { TuiCommand } from "../tui/command";
import type { ToolRendererMap } from "../tui/tool-call-view";
import {
  assertKeys,
  requiredString,
  snapshotDataRecord,
  snapshotOptionalStringArray,
  snapshotStringArray,
} from "./data-validation";
import { snapshotModelProvider } from "./model-provider-validation";
import {
  snapshotCommandName,
  snapshotToolName,
  snapshotToolRendererName,
} from "./name-validation";
import type { CodingAgentExtensionModelProvider } from "./types";

const MIGRATION_ID_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/;

export type ValidatedCapability =
  | { readonly command: TuiCommand; readonly kind: "command" }
  | { readonly fragments: readonly string[]; readonly kind: "instructions" }
  | {
      readonly kind: "model-provider";
      readonly provider: CodingAgentExtensionModelProvider;
    }
  | {
      readonly kind: "resources";
      readonly prompts: readonly string[];
      readonly skills: readonly string[];
    }
  | {
      readonly kind: "thread-migration";
      readonly migration: ThreadStateMigration;
    }
  | {
      readonly kind: "tool-renderer";
      readonly renderer: ToolRendererMap[string];
      readonly toolName: string;
    }
  | {
      readonly entries: readonly (readonly [string, ToolSet[string]])[];
      readonly kind: "tools";
    };

export function validateExtensionCapability(
  value: unknown,
  extensionId: string
): ValidatedCapability {
  const capability = snapshotDataRecord(value, "Extension capability");
  const kind = requiredString(capability.kind, "Extension capability kind");
  switch (kind) {
    case "command":
      assertKeys(capability, ["command", "kind"], "Extension capability");
      return { command: snapshotCommand(capability.command), kind };
    case "instructions":
      assertKeys(capability, ["fragments", "kind"], "Extension capability");
      {
        const fragments = snapshotStringArray(
          capability.fragments,
          "Instruction fragments"
        ).map(snapshotInstruction);
        if (fragments.length === 0) {
          throw new TypeError(
            "Instructions capability must provide at least one fragment"
          );
        }
        return { fragments, kind };
      }
    case "model-provider":
      assertKeys(capability, ["kind", "provider"], "Extension capability");
      return {
        kind,
        provider: snapshotModelProvider(capability.provider),
      };
    case "resources": {
      assertKeys(
        capability,
        ["kind", "prompts", "skills"],
        "Extension capability",
        ["kind"]
      );
      const prompts = snapshotResourceDirectories(
        capability.prompts,
        `Extension "${extensionId}" resource prompt directories`
      );
      const skills = snapshotResourceDirectories(
        capability.skills,
        `Extension "${extensionId}" resource skill directories`
      );
      if (prompts.length === 0 && skills.length === 0) {
        throw new TypeError(
          "Resources capability must provide at least one directory"
        );
      }
      return { kind, prompts, skills };
    }
    case "thread-migration":
      assertKeys(capability, ["kind", "migration"], "Extension capability");
      return {
        kind,
        migration: snapshotThreadMigration(extensionId, capability.migration),
      };
    case "tool-renderer": {
      assertKeys(
        capability,
        ["kind", "renderer", "toolName"],
        "Extension capability"
      );
      const toolName = snapshotToolRendererName(capability.toolName);
      if (typeof capability.renderer !== "function") {
        throw new TypeError(`Tool renderer "${toolName}" must be a function`);
      }
      return {
        kind,
        renderer: capability.renderer as ToolRendererMap[string],
        toolName,
      };
    }
    case "tools":
      assertKeys(capability, ["kind", "tools"], "Extension capability");
      {
        const entries = snapshotToolEntries(capability.tools);
        if (entries.length === 0) {
          throw new TypeError(
            "Tools capability must provide at least one tool"
          );
        }
        return { entries, kind };
      }
    default:
      throw new TypeError(`Unknown extension capability kind "${kind}"`);
  }
}

export function snapshotCommand(value: unknown): TuiCommand {
  const command = snapshotDataRecord(value, "Coding agent command");
  assertKeys(
    command,
    [
      "aliases",
      "argumentSuggestions",
      "description",
      "displayName",
      "execute",
      "name",
    ],
    "Coding agent command",
    ["description", "execute", "name"]
  );
  const name = snapshotCommandName(command.name);
  const aliases = snapshotOptionalStringArray(
    command.aliases,
    `Command "${name}" aliases`
  ).map(snapshotCommandName);
  const names = new Set<string>([name.toLowerCase()]);
  for (const alias of aliases) {
    const normalized = alias.toLowerCase();
    if (names.has(normalized)) {
      throw new Error(
        `Duplicate coding agent command name or alias "${alias}"`
      );
    }
    names.add(normalized);
  }
  const description = requiredString(
    command.description,
    `Command "${name}" description`
  );
  if (typeof command.execute !== "function") {
    throw new TypeError(`Command "${name}" execute must be a function`);
  }
  const argumentSuggestions = snapshotOptionalStringArray(
    command.argumentSuggestions,
    `Command "${name}" argument suggestions`
  );
  const displayName =
    command.displayName === undefined
      ? undefined
      : requiredString(command.displayName, `Command "${name}" display name`);
  return Object.freeze({
    aliases: Object.freeze(aliases),
    argumentSuggestions: Object.freeze(argumentSuggestions),
    description,
    ...(displayName === undefined ? {} : { displayName }),
    execute: command.execute as TuiCommand["execute"],
    name,
  });
}

export function snapshotInstruction(value: unknown): string {
  const fragment = requiredString(value, "Instruction fragment");
  if (fragment.trim().length === 0) {
    throw new TypeError("Instruction fragment must not be empty");
  }
  return fragment;
}

export function snapshotThreadMigration(
  extensionId: string,
  value: unknown
): ThreadStateMigration {
  const migration = snapshotDataRecord(value, "Thread migration");
  assertKeys(migration, ["id", "migrate", "version"], "Thread migration", [
    "id",
    "migrate",
    "version",
  ]);
  const localId = requiredString(migration.id, "Thread migration id").trim();
  const qualifiedId = `${extensionId}/${localId}`;
  if (!MIGRATION_ID_PATTERN.test(localId)) {
    throw new TypeError(`Invalid thread migration id: ${qualifiedId}`);
  }
  if (
    !Number.isSafeInteger(migration.version) ||
    (migration.version as number) < 1
  ) {
    throw new TypeError(
      `Thread migration "${qualifiedId}" version must be a positive integer`
    );
  }
  if (typeof migration.migrate !== "function") {
    throw new TypeError(
      `Thread migration "${qualifiedId}" migrate must be a function`
    );
  }
  return Object.freeze({
    id: qualifiedId,
    migrate: migration.migrate as ThreadStateMigration["migrate"],
    version: migration.version as number,
  });
}

function snapshotResourceDirectories(
  value: unknown,
  label: string
): readonly string[] {
  const directories = snapshotOptionalStringArray(value, label);
  for (const directory of directories) {
    if (directory.trim().length === 0) {
      throw new TypeError(`${label} must not contain empty paths`);
    }
    if (!isAbsolute(directory)) {
      throw new TypeError(
        `${label} must be absolute paths (got ${JSON.stringify(directory)})`
      );
    }
  }
  return Object.freeze(directories);
}

export function snapshotToolEntries(
  value: unknown
): readonly (readonly [string, ToolSet[string]])[] {
  const tools = snapshotDataRecord(value, "Extension tools");
  return Object.freeze(
    Object.entries(tools).map(([name, definition]) =>
      snapshotToolEntry(name, definition)
    )
  );
}

export function snapshotToolEntry(
  nameValue: unknown,
  definition: unknown
): readonly [string, ToolSet[string]] {
  const name = snapshotToolName(nameValue);
  if (
    (typeof definition !== "object" || definition === null) &&
    typeof definition !== "function"
  ) {
    throw new TypeError(`Tool "${name}" must be an object`);
  }
  return Object.freeze([name, definition as ToolSet[string]] as const);
}
