import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const fixtureId = randomUUID();
const legacyFixture = `experimental/nextjs-bench/results/boundaries-${fixtureId}.js`;
const migratedFixture = `.artifacts/nextjs-bench/results/boundaries-${fixtureId}.js`;
const sourceFixture = `experimental/nextjs-bench/src/boundaries-${fixtureId}.js`;
const pnpmBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runBoundaries() {
  return spawnSync(pnpmBinary, ["boundaries"], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    timeout: 30_000,
  });
}

afterEach(() => {
  rmSync(legacyFixture, { force: true });
  rmSync(migratedFixture, { force: true });
  rmSync(sourceFixture, { force: true });
  for (const directory of [
    "experimental/nextjs-bench/results",
    ".artifacts/nextjs-bench/results",
    ".artifacts/nextjs-bench",
    ".artifacts",
  ]) {
    try {
      rmdirSync(directory);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTEMPTY"].includes(String(error.code))
        )
      ) {
        throw error;
      }
    }
  }
});

describe("package boundaries", () => {
  it("moves legacy generated results outside workspace boundaries", () => {
    mkdirSync("experimental/nextjs-bench/results", { recursive: true });
    writeFileSync(legacyFixture, 'import "not-a-dependency";\n', "utf8");

    const result = runBoundaries();

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(legacyFixture)).toBe(false);
    expect(existsSync(migratedFixture)).toBe(true);
  }, 30_000);

  it("still checks the Next.js benchmark source package", () => {
    writeFileSync(sourceFixture, 'import "not-a-dependency";\n', "utf8");

    const result = runBoundaries();

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(sourceFixture);
  }, 30_000);
});
