import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Default directory backing `services.state` JSON files. */
export function defaultExtensionStateRoot(): string {
  return join(homedir(), ".pss", "extension-state");
}

export interface ExtensionStateSnapshot {
  /** Drop the backup after the runtime swap succeeded. */
  discard(): Promise<void>;
  /** Restore the snapshotted state files after a failed swap. */
  restore(): Promise<void>;
}

/**
 * Snapshot the state files of the given extensions before a runtime swap
 * activates.
 *
 * Replacement activation runs against the same per-extension state files as
 * the runtime it replaces, so a failed activation could leave partially
 * upgraded state behind for the recovered runtime. Only the listed
 * extensions' files are captured and restored — state belonging to other
 * extensions or written by concurrent `pss` sessions stays untouched.
 */
export async function snapshotExtensionState(
  extensionIds: readonly string[],
  root: string = defaultExtensionStateRoot()
): Promise<ExtensionStateSnapshot> {
  const backupRoot = await mkdtemp(join(tmpdir(), "pss-state-backup-"));
  const entries: {
    readonly backupPath: string;
    readonly existed: boolean;
    readonly path: string;
  }[] = [];
  for (const [index, extensionId] of extensionIds.entries()) {
    const path = join(root, `${encodeURIComponent(extensionId)}.json`);
    const backupPath = join(backupRoot, `${index}.json`);
    entries.push({
      backupPath,
      existed: await tryCopy(path, backupPath),
      path,
    });
  }
  return {
    discard: async () => {
      await rm(backupRoot, { force: true, recursive: true });
    },
    restore: async () => {
      for (const entry of entries) {
        if (entry.existed) {
          await mkdir(dirname(entry.path), { recursive: true });
          await copyFile(entry.backupPath, entry.path);
        } else {
          await rm(entry.path, { force: true });
        }
      }
      await rm(backupRoot, { force: true, recursive: true });
    },
  };
}

async function tryCopy(source: string, target: string): Promise<boolean> {
  try {
    await copyFile(source, target);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
