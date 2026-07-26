import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
 * Snapshot the extension-state directory before a runtime swap activates.
 *
 * Replacement activation runs against the same per-extension state files as
 * the runtime it replaces, so a failed activation could leave partially
 * upgraded state behind for the recovered runtime. Restoring this snapshot
 * puts the files back exactly as the previous runtime's cleanup left them.
 */
export async function snapshotExtensionState(
  root: string = defaultExtensionStateRoot()
): Promise<ExtensionStateSnapshot> {
  const backupRoot = await mkdtemp(join(tmpdir(), "pss-state-backup-"));
  const backupPath = join(backupRoot, "state");
  const rootExists = await directoryExists(root);
  if (rootExists) {
    await cp(root, backupPath, { recursive: true });
  }
  return {
    discard: async () => {
      await rm(backupRoot, { force: true, recursive: true });
    },
    restore: async () => {
      await rm(root, { force: true, recursive: true });
      if (rootExists) {
        await cp(backupPath, root, { recursive: true });
      }
      await rm(backupRoot, { force: true, recursive: true });
    },
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
