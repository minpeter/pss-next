import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withProcessFileLock } from "@minpeter/pss-runtime/platform/file";
import { z } from "zod";
import type { ExtensionSettingsEntry } from "./types";

/** In-process serialization per settings path (complements cross-process lockfile). */
const settingsQueues = new Map<string, Promise<unknown>>();
const operationQueues = new Map<string, Promise<unknown>>();

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

/**
 * Serialize read-modify-write updates to a settings file across concurrent
 * install/update/remove callers (in-process queue + exclusive lockfile).
 */
export async function updateExtensionSettings(
  path: string,
  update: (
    document: ExtensionSettingsDocument
  ) => ExtensionSettingsDocument | Promise<ExtensionSettingsDocument>
): Promise<ExtensionSettingsDocument> {
  return await withExtensionSettingsLock(path, async () => {
    const current = await readExtensionSettings(path);
    const next = await update(current);
    await writeExtensionSettings(path, next);
    return next;
  });
}

export async function withExtensionSettingsLock<Result>(
  path: string,
  run: () => Promise<Result>
): Promise<Result> {
  const previous = settingsQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  settingsQueues.set(path, queued);
  await previous.catch(() => undefined);
  try {
    return await withProcessFileLock(
      `${path}.lock`,
      "extension settings",
      run,
      { timeoutMs: SETTINGS_LOCK_WAIT_MS }
    );
  } finally {
    release();
    if (settingsQueues.get(path) === queued) {
      settingsQueues.delete(path);
    }
  }
}

/** Serialize the entire package/settings transaction for one install root. */
export async function withExtensionOperationLock<Result>(
  installRoot: string,
  run: () => Promise<Result>
): Promise<Result> {
  const lockPath = `${installRoot}.operation.lock`;
  const previous = operationQueues.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  operationQueues.set(lockPath, queued);
  await previous.catch(() => undefined);
  try {
    return await withProcessFileLock(lockPath, "extension operation", run, {
      timeoutMs: OPERATION_LOCK_WAIT_MS,
    });
  } finally {
    release();
    if (operationQueues.get(lockPath) === queued) {
      operationQueues.delete(lockPath);
    }
  }
}

const SETTINGS_LOCK_WAIT_MS = 10_000;
const OPERATION_LOCK_WAIT_MS = 15 * 60_000;

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

export async function addTrustedProject(
  path: string,
  project: string
): Promise<void> {
  await withExtensionSettingsLock(path, async () => {
    const projects = await readTrustedProjects(path);
    if (!projects.includes(project)) {
      await writeTrustedProjects(path, [...projects, project]);
    }
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
