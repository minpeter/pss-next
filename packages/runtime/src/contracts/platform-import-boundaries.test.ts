import { glob, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const PLATFORM_ROOT = new URL("../platform/", import.meta.url);
const IMPORT_SPECIFIER_PATTERN =
  /\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/;

describe("platform adapter import boundaries", () => {
  it("keeps production Cloudflare files independent of Celld", async () => {
    const crossAdapterImports = await findCrossAdapterImports(
      "cloudflare",
      "celld"
    );

    expect(crossAdapterImports).toEqual([]);
  });

  it("keeps production Celld files independent of Cloudflare", async () => {
    const crossAdapterImports = await findCrossAdapterImports(
      "celld",
      "cloudflare"
    );

    expect(crossAdapterImports).toEqual([]);
  });
});

async function findCrossAdapterImports(
  adapter: "cloudflare" | "celld",
  forbiddenAdapter: "cloudflare" | "celld"
): Promise<readonly string[]> {
  const sourcePaths: string[] = [];
  for await (const sourcePath of glob("**/*.ts", { cwd: PLATFORM_ROOT })) {
    if (
      sourcePath.split("/").includes(adapter) &&
      !sourcePath.endsWith(".test.ts") &&
      !sourcePath.includes("-test-") &&
      !sourcePath.includes("/node-test/") &&
      !sourcePath.includes("/durable-object-test/")
    ) {
      sourcePaths.push(sourcePath);
    }
  }

  const violations: string[] = [];
  for (const sourcePath of sourcePaths.sort()) {
    const source = await readFile(new URL(sourcePath, PLATFORM_ROOT), "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      const importMatch = line.match(IMPORT_SPECIFIER_PATTERN);
      const specifier = importMatch?.[1] ?? importMatch?.[2];
      if (specifier?.split("/").includes(forbiddenAdapter)) {
        violations.push(`${sourcePath}:${index + 1}: ${specifier}`);
      }
    }
  }
  return violations;
}
