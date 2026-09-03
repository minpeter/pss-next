import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectRuntimePublicApi,
  compareCodeUnits,
} from "./runtime-public-api-collect.mjs";
import { formatRuntimePublicApiSnapshot } from "./runtime-public-api-format.mjs";

export const RUNTIME_API_SNAPSHOT_PATH = join(
  "packages",
  "runtime",
  "public-api.snapshot.json"
);

export function diffPublicApi(expected, actual) {
  const lines = [];
  const surfaceNames = new Set([
    ...Object.keys(expected.surfaces ?? {}),
    ...Object.keys(actual.surfaces ?? {}),
  ]);
  for (const surface of [...surfaceNames].sort((left, right) =>
    compareCodeUnits(left, right)
  )) {
    const expectedNames = new Set(expected.surfaces?.[surface] ?? []);
    const actualNames = new Set(actual.surfaces?.[surface] ?? []);
    for (const name of [...expectedNames]
      .filter((name) => !actualNames.has(name))
      .sort((left, right) => compareCodeUnits(left, right))) {
      lines.push(`- ${surface}: ${name}`);
    }
    for (const name of [...actualNames]
      .filter((name) => !expectedNames.has(name))
      .sort((left, right) => compareCodeUnits(left, right))) {
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
  writeFileSync(snapshotFile, formatRuntimePublicApiSnapshot(snapshot));
  return snapshotFile;
}
