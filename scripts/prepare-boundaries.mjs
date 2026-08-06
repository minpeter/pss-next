import { access, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const legacyResults = resolve(
  repositoryRoot,
  "experimental/nextjs-bench/results"
);
const results = resolve(repositoryRoot, ".artifacts/nextjs-bench/results");

let hasLegacyResults = true;
try {
  await access(legacyResults);
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    hasLegacyResults = false;
  } else {
    throw error;
  }
}

if (hasLegacyResults) {
  await mkdir(dirname(results), { recursive: true });
  try {
    await rename(legacyResults, results);
    process.stdout.write(
      `Moved legacy Next.js benchmark results to ${results}.\n`
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EEXIST", "ENOTEMPTY"].includes(String(error.code))
    ) {
      throw new Error(
        `Cannot migrate ${legacyResults}: ${results} already exists. Merge or remove the legacy directory before running package boundaries.`,
        { cause: error }
      );
    }
    throw error;
  }
}
