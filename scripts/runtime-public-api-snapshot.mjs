import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const RUNTIME_API_SNAPSHOT_PATH = join(
  "packages",
  "runtime",
  "public-api.snapshot.json"
);

const DECLARATION_EXPORT_RE =
  /export\s*\{([\s\S]*?)\}\s*(?:from\s*["'][^"']+["'])?\s*;/g;
const EXPORT_ALIAS_RE = /\s+as\s+/;

function declarationPath(packageDirectory, target) {
  const typesTarget = typeof target === "string" ? target : target.types;
  if (typeof typesTarget !== "string") {
    throw new Error("Runtime export does not have a types target");
  }
  return resolve(packageDirectory, typesTarget);
}

function declarationExports(file) {
  const text = readFileSync(file, "utf8");
  const exports = new Set();
  const blocks = text.matchAll(DECLARATION_EXPORT_RE);
  for (const block of blocks) {
    for (const rawName of block[1].split(",")) {
      const entry = rawName.trim();
      if (!entry) {
        continue;
      }
      const typeOnly = entry.startsWith("type ");
      const withoutType = typeOnly ? entry.slice(5).trim() : entry;
      const alias = withoutType.split(EXPORT_ALIAS_RE).at(-1)?.trim();
      if (alias) {
        exports.add(`${typeOnly ? "type" : "value"} ${alias}`);
      }
    }
  }
  return [...exports].sort((left, right) => left.localeCompare(right));
}

export function collectRuntimePublicApi(cwd = process.cwd()) {
  const packageDirectory = join(cwd, "packages", "runtime");
  const manifest = JSON.parse(
    readFileSync(join(packageDirectory, "package.json"), "utf8")
  );
  const entrypoints = Object.entries(manifest.exports)
    .filter(([, target]) =>
      typeof target === "string" ? target.endsWith(".d.ts") : target.types
    )
    .map(([subpath, target]) => [
      subpath,
      declarationPath(packageDirectory, target),
    ]);

  const missing = entrypoints
    .map(([, file]) => file)
    .filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `Build @minpeter/pss-runtime before checking its public API; missing ${missing.join(
        ", "
      )}`
    );
  }

  const surfaces = Object.fromEntries(
    entrypoints.map(([subpath, file]) => [subpath, declarationExports(file)])
  );

  return {
    schemaVersion: 1,
    package: manifest.name,
    surfaces: Object.fromEntries(
      Object.entries(surfaces).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ),
  };
}

export function diffPublicApi(expected, actual) {
  const lines = [];
  const surfaceNames = new Set([
    ...Object.keys(expected.surfaces ?? {}),
    ...Object.keys(actual.surfaces ?? {}),
  ]);
  for (const surface of [...surfaceNames].sort((left, right) =>
    left.localeCompare(right)
  )) {
    const expectedNames = new Set(expected.surfaces?.[surface] ?? []);
    const actualNames = new Set(actual.surfaces?.[surface] ?? []);
    for (const name of [...expectedNames]
      .filter((name) => !actualNames.has(name))
      .sort((left, right) => left.localeCompare(right))) {
      lines.push(`- ${surface}: ${name}`);
    }
    for (const name of [...actualNames]
      .filter((name) => !expectedNames.has(name))
      .sort((left, right) => left.localeCompare(right))) {
      lines.push(`+ ${surface}: ${name}`);
    }
  }
  return lines;
}

export function findRuntimePublicApiSnapshotErrors({ cwd, packages }) {
  if (!packages.includes("runtime")) {
    return [];
  }
  const snapshotFile = join(cwd, RUNTIME_API_SNAPSHOT_PATH);
  if (!existsSync(snapshotFile)) {
    return [`${RUNTIME_API_SNAPSHOT_PATH}: public API snapshot is missing`];
  }
  try {
    const expected = JSON.parse(readFileSync(snapshotFile, "utf8"));
    const actual = collectRuntimePublicApi(cwd);
    const diff = diffPublicApi(expected, actual);
    return diff.length === 0
      ? []
      : [
          `${RUNTIME_API_SNAPSHOT_PATH}: runtime public API changed:\n${diff.join(
            "\n"
          )}\nRun pnpm api:update after reviewing and documenting the change.`,
        ];
  } catch (error) {
    return [
      `${RUNTIME_API_SNAPSHOT_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

export function writeRuntimePublicApiSnapshot(cwd = process.cwd()) {
  const snapshotFile = join(cwd, RUNTIME_API_SNAPSHOT_PATH);
  const snapshot = collectRuntimePublicApi(cwd);
  writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshotFile;
}
