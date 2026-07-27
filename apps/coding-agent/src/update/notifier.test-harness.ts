import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TempCacheContext {
  readonly cachePath: string;
  readonly lines: string[];
  readonly tasks: (() => Promise<void>)[];
}

export const withTempCache =
  (run: (context: TempCacheContext) => Promise<void>) => async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-notifier-"));
    const lines: string[] = [];
    const tasks: (() => Promise<void>)[] = [];
    try {
      await run({
        cachePath: join(directory, "update-check.json"),
        lines,
        tasks,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  };
