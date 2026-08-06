import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const generatedResultsDirectory = "experimental/nextjs-bench/results";
const generatedFixture = `${generatedResultsDirectory}/boundaries-${randomUUID()}.js`;

afterEach(() => {
  rmSync(generatedFixture, { force: true });
});

describe("package boundaries", () => {
  it("does not scan ignored Next.js benchmark results", () => {
    mkdirSync(generatedResultsDirectory, { recursive: true });
    writeFileSync(
      generatedFixture,
      'import "@minpeter/pss-runtime";\n',
      "utf8"
    );

    const result = spawnSync("pnpm", ["boundaries"], {
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain(generatedFixture);
    expect(result.stderr).not.toContain(generatedFixture);
  }, 30_000);
});
