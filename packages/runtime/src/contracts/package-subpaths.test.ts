import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface RuntimeExport {
  readonly "@minpeter/pss-source": string;
  readonly import?: string;
  readonly types?: string;
}

interface RuntimePackageJson {
  readonly exports: Record<string, RuntimeExport>;
}

describe("runtime package subpaths", () => {
  it("declares memory as a platform implementation subpath", async () => {
    const packageJson = await readRuntimePackageJson();

    expect(packageJson.exports["./platform/memory"]).toMatchObject({
      "@minpeter/pss-source": "./src/platform/memory/index.ts",
      import: "./dist/platform/memory/index.js",
      types: "./dist/platform/memory/index.d.ts",
    });
    expect(packageJson.exports["./thread-store/memory"]).toBeUndefined();
    expect(packageJson.exports["./execution/memory"]).toBeUndefined();
  });

  it("declares the Cloudflare adapter as a platform implementation subpath", async () => {
    const packageJson = await readRuntimePackageJson();

    expect(packageJson.exports["./platform/cloudflare"]).toMatchObject({
      "@minpeter/pss-source": "./src/platform/cloudflare/index.ts",
      import: "./dist/platform/cloudflare/index.js",
      types: "./dist/platform/cloudflare/index.d.ts",
    });
    expect(packageJson.exports["./platform/cloudflare-agents"]).toBeUndefined();
    expect(packageJson.exports["./cloudflare"]).toBeUndefined();
    expect(packageJson.exports["./cloudflare-agents"]).toBeUndefined();
  });

  it("exports the combined Cloudflare platform facade from the canonical subpath", async () => {
    const cloudflarePlatform = await import("../platform/cloudflare");
    const canonicalCloudflareExports = [
      "createCloudflareHost",
      "createCloudflareStorageHost",
      "createCloudflareScheduledWorkScheduler",
      "createCloudflareAgentsFiberScheduler",
      "createCloudflarePlatformContext",
      "recoverCloudflareAgentsFiber",
      "startCloudflareAgentsResumeFiber",
      "drainAgentTurn",
    ] as const;

    for (const exportName of canonicalCloudflareExports) {
      expect(cloudflarePlatform).toHaveProperty(exportName);
    }
  }, 30_000);

  it("declares the file adapter as a platform implementation subpath", async () => {
    const packageJson = await readRuntimePackageJson();

    expect(packageJson.exports["./platform/file"]).toMatchObject({
      "@minpeter/pss-source": "./src/platform/file/index.ts",
      import: "./dist/platform/file/index.js",
      types: "./dist/platform/file/index.d.ts",
    });
    expect(packageJson.exports["./platform/node"]).toBeUndefined();
    expect(packageJson.exports["./node"]).toBeUndefined();
  });

  it("declares the SQL queue adapter as a platform implementation subpath", async () => {
    const packageJson = await readRuntimePackageJson();
    const sqlQueue = await import("../platform/sql-queue");

    expect(packageJson.exports["./platform/sql-queue"]).toMatchObject({
      "@minpeter/pss-source": "./src/platform/sql-queue/index.ts",
      import: "./dist/platform/sql-queue/index.js",
      types: "./dist/platform/sql-queue/index.d.ts",
    });
    expect(sqlQueue).toHaveProperty("createSqlQueueHost");
    expect(sqlQueue).toHaveProperty("SqlHostStore");
    expect(sqlQueue).toHaveProperty("SqlQueueScheduler");
  });

  it("declares the OpenTelemetry observability subpath", async () => {
    const packageJson = await readRuntimePackageJson();
    const root = await import("../index");
    const otel = await import("../otel");

    expect(packageJson.exports["./otel"]).toMatchObject({
      "@minpeter/pss-source": "./src/otel/index.ts",
      import: "./dist/otel/index.js",
      types: "./dist/otel/index.d.ts",
    });
    expect(otel).toHaveProperty("openTelemetry");
    expect(otel).toHaveProperty("traceAgentTurn");
    expect(root).not.toHaveProperty("openTelemetry");
    expect(root).not.toHaveProperty("traceAgentTurn");
  });

  it("declares the channel adapter contract subpath", async () => {
    const packageJson = await readRuntimePackageJson();

    expect(packageJson.exports["./channel"]).toMatchObject({
      "@minpeter/pss-source": "./src/channel/index.ts",
      import: "./dist/channel/index.js",
      types: "./dist/channel/index.d.ts",
    });
  });

  it("declares the testing subpath for AgentTurn test helpers", async () => {
    const packageJson = await readRuntimePackageJson();

    expect(packageJson.exports["./testing"]).toMatchObject({
      "@minpeter/pss-source": "./src/testing/index.ts",
      import: "./dist/testing/index.js",
      types: "./dist/testing/index.d.ts",
    });
  });
});

async function readRuntimePackageJson(): Promise<RuntimePackageJson> {
  const packageJsonText = await readFile(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
    "utf8"
  );
  return parseRuntimePackageJson(JSON.parse(packageJsonText));
}

function parseRuntimePackageJson(value: unknown): RuntimePackageJson {
  if (!(isRecord(value) && isRecord(value.exports))) {
    throw new TypeError("Expected runtime package.json exports object");
  }

  const exports: Record<string, RuntimeExport> = {};
  for (const [subpath, exportValue] of Object.entries(value.exports)) {
    if (!isRuntimeExport(exportValue)) {
      throw new TypeError(`Expected runtime export object for ${subpath}`);
    }
    exports[subpath] = exportValue;
  }
  return { exports };
}

function isRuntimeExport(value: unknown): value is RuntimeExport {
  return (
    isRecord(value) &&
    typeof value["@minpeter/pss-source"] === "string" &&
    (value.import === undefined || typeof value.import === "string") &&
    (value.types === undefined || typeof value.types === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
