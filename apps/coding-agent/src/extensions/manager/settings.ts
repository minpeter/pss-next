import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ExtensionSettingsEntry } from "./types";

const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("module"), path: z.string().min(1) }),
  z.object({
    kind: z.literal("package"),
    packageName: z.string().min(1),
  }),
]);

const entrySchema = z.object({
  config: z.record(z.string(), z.json()).optional(),
  enabled: z.boolean(),
  id: z.string().min(1),
  installedAt: z.string().min(1),
  source: z.string().min(1),
  sourceKind: z.enum(["git", "local", "npm"]),
  target: targetSchema,
  updatedAt: z.string().min(1).optional(),
});

const settingsSchema = z
  .object({
    extensions: z.array(entrySchema).optional(),
  })
  .loose();

const trustSchema = z.object({
  projects: z.array(z.string().min(1)),
  schemaVersion: z.literal(1),
});

export interface ExtensionSettingsDocument {
  readonly extensions: readonly ExtensionSettingsEntry[];
  readonly values: Readonly<Record<string, unknown>>;
}

export async function readExtensionSettings(
  path: string
): Promise<ExtensionSettingsDocument> {
  const parsed = await readJson(path);
  if (parsed === undefined) {
    return { extensions: [], values: {} };
  }
  const result = settingsSchema.safeParse(parsed);
  if (!result.success) {
    throw new TypeError(`Invalid extension settings at ${path}`, {
      cause: result.error,
    });
  }
  return {
    extensions: result.data.extensions ?? [],
    values: result.data,
  };
}

export async function writeExtensionSettings(
  path: string,
  document: ExtensionSettingsDocument
): Promise<void> {
  await writeJsonAtomically(path, {
    ...document.values,
    extensions: document.extensions,
  });
}

export async function readTrustedProjects(
  path: string
): Promise<readonly string[]> {
  const parsed = await readJson(path);
  if (parsed === undefined) {
    return [];
  }
  const result = trustSchema.safeParse(parsed);
  if (!result.success) {
    throw new TypeError(`Invalid trusted-project settings at ${path}`, {
      cause: result.error,
    });
  }
  return result.data.projects;
}

export async function writeTrustedProjects(
  path: string,
  projects: readonly string[]
): Promise<void> {
  await writeJsonAtomically(path, {
    projects: [...projects],
    schemaVersion: 1,
  });
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    if (error instanceof SyntaxError) {
      throw new TypeError(`Invalid JSON at ${path}`, { cause: error });
    }
    throw error;
  }
}

async function writeJsonAtomically(
  path: string,
  value: unknown
): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code;
}
