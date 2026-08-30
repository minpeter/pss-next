import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNodeError } from "../../../../internal/guards";

const DATA_DIRECTORIES = [
  "checkpoints",
  "events",
  "inputs",
  "notifications",
  "runs",
  "scheduled-work",
  "thread-events",
  "threads",
] as const;

const CURRENT_GENERATION_FILE = ".current-generation";
export const GENERATIONS_DIRECTORY = "generations";
export const INITIAL_GENERATION_ID = "main";

export async function copyDataDirectories(
  source: string,
  target: string
): Promise<void> {
  for (const dataDirectory of DATA_DIRECTORIES) {
    const sourceDirectory = join(source, dataDirectory);
    const targetDirectory = join(target, dataDirectory);
    try {
      await cp(sourceDirectory, targetDirectory, { recursive: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

export async function currentDataDirectory(directory: string): Promise<string> {
  const generationId = await currentGenerationId(directory);
  return join(directory, GENERATIONS_DIRECTORY, generationId);
}

export async function migrateLegacyScheduledWork(
  directory: string,
  target: string
): Promise<void> {
  const source = join(directory, "scheduled-work");
  try {
    await cp(source, join(target, "scheduled-work"), { recursive: true });
    await rm(source, { force: true, recursive: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function currentGenerationId(directory: string): Promise<string> {
  const file = join(directory, CURRENT_GENERATION_FILE);
  try {
    const generationId = (await readFile(file, "utf8")).trim();
    if (generationId.length > 0) {
      return generationId;
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw error;
    }
  }

  await mkdir(join(directory, GENERATIONS_DIRECTORY, INITIAL_GENERATION_ID), {
    recursive: true,
  });
  await writeCurrentGeneration(directory, INITIAL_GENERATION_ID);
  return INITIAL_GENERATION_ID;
}

export async function writeCurrentGeneration(
  directory: string,
  generationId: string
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await mkdir(join(directory, GENERATIONS_DIRECTORY, generationId), {
    recursive: true,
  });
  const file = join(directory, CURRENT_GENERATION_FILE);
  const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempFile, `${generationId}\n`, "utf8");
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}
