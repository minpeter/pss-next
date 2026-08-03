import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Benchmark packages are plain .mjs with no transpile step, so the "build"
 * gate is a syntax check of every Node script plus a dist marker for turbo.
 */
export async function checkNodeScripts({
  packageRoot,
  sourceDirectories = ["scripts", "src", "test"],
}) {
  async function collectCheckedFiles(directory) {
    // A configured root directory that does not exist (e.g. no test/ yet)
    // contributes no files; other filesystem errors still propagate.
    const entries = await readdir(join(packageRoot, directory), {
      withFileTypes: true,
    }).catch((error) => {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    const files = [];
    for (const entry of entries) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        files.push(...(await collectCheckedFiles(relative)));
      } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
        files.push(relative);
      }
    }
    return files;
  }

  const checkedFiles = (
    await Promise.all(sourceDirectories.map(collectCheckedFiles))
  ).flat();

  await Promise.all(
    checkedFiles.map((file) =>
      execFileAsync(process.execPath, ["--check", join(packageRoot, file)])
    )
  );

  const reportPath = resolve(packageRoot, "dist", "build.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify({ checkedFiles, checkedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );

  return checkedFiles;
}
