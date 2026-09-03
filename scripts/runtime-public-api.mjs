#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import { collectRuntimePublicApi } from "./runtime-public-api-collect.mjs";
import {
  diffPublicApi,
  RUNTIME_API_SNAPSHOT_PATH,
  writeRuntimePublicApiSnapshot,
} from "./runtime-public-api-snapshot.mjs";

const [command] = process.argv.slice(2);
if (command === "update") {
  console.log(`Wrote ${writeRuntimePublicApiSnapshot()}`);
} else if (command === "check") {
  const expected = JSON.parse(readFileSync(RUNTIME_API_SNAPSHOT_PATH, "utf8"));
  const diff = diffPublicApi(expected, collectRuntimePublicApi());
  if (diff.length > 0) {
    console.error(
      `Runtime public API differs from ${RUNTIME_API_SNAPSHOT_PATH}:\n${diff.join(
        "\n"
      )}\nRun pnpm api:update after reviewing and documenting the change.`
    );
    process.exitCode = 1;
  } else {
    console.log("Runtime public API snapshot matches");
  }
} else {
  console.error("Usage: node scripts/runtime-public-api.mjs <check|update>");
  process.exitCode = 1;
}
