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

interface RuntimePublicApiSnapshot {
  readonly surfaces: Record<string, readonly string[]>;
}

const DURABLE_OBJECT_EXPORTS = [
  ["./platform/durable-object", "platform/durable-object/host/storage-host"],
  [
    "./platform/durable-object/cloudflare",
    "platform/durable-object/cloudflare/agents/index",
  ],
  [
    "./platform/durable-object/cloudflare/image-codecs",
    "platform/durable-object/cloudflare/image-codecs-edge",
  ],
  ["./platform/durable-object/celld", "platform/durable-object/celld/host"],
] as const;

const LEGACY_DURABLE_OBJECT_EXPORTS = [
  "./platform/cloudflare",
  "./platform/cloudflare/image-codecs",
  "./platform/celld",
] as const;

/**
 * Generic storage aliases the Cloudflare subpath re-exported before the
 * durable-object hierarchy landed. They now live only on `/durable-object`.
 */
const FORBIDDEN_CLOUDFLARE_ALIASES = [
  "CloudflareDurableObjectStorage",
  "CloudflareScheduledThreadPrompt",
  "CloudflareStorageHostOptions",
  "CloudflareAttachmentStore",
  "InMemoryCloudflareDurableObjectStorage",
  "ackScheduledCloudflareRun",
  "ackScheduledCloudflareThreadPrompt",
  "createCloudflareScheduledWorkScheduler",
  "createCloudflareStorageHost",
  "listScheduledCloudflareRuns",
  "listScheduledCloudflareThreadPrompts",
] as const;

const REQUIRED_CLOUDFLARE_EXPORTS = [
  "createCloudflareHost",
  "createCloudflarePlatformContext",
  "fetchCloudflareDurableObject",
  "startCloudflareAgentsResumeFiber",
] as const;

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

  it.each(DURABLE_OBJECT_EXPORTS)(
    "declares %s as a canonical durable-object subpath",
    async (subpath, target) => {
      const packageJson = await readRuntimePackageJson();

      expect(packageJson.exports[subpath]).toMatchObject({
        "@minpeter/pss-source": `./src/${target}.ts`,
        import: `./dist/${target}.js`,
        types: `./dist/${target}.d.ts`,
      });
    }
  );

  it.each(LEGACY_DURABLE_OBJECT_EXPORTS)(
    "does not declare the legacy durable-object subpath %s",
    async (subpath) => {
      const packageJson = await readRuntimePackageJson();

      expect(packageJson.exports[subpath]).toBeUndefined();
    }
  );

  it("drops every legacy generic alias from the cloudflare subpath", async () => {
    const cloudflare = await readRuntimePublicApiNames(
      "./platform/durable-object/cloudflare"
    );

    const reachable = FORBIDDEN_CLOUDFLARE_ALIASES.filter((name) =>
      cloudflare.has(name)
    );

    expect(reachable).toEqual([]);
  });

  it("keeps Cloudflare-specific helpers on the cloudflare subpath", async () => {
    const cloudflare = await readRuntimePublicApiNames(
      "./platform/durable-object/cloudflare"
    );

    const missing = REQUIRED_CLOUDFLARE_EXPORTS.filter(
      (name) => !cloudflare.has(name)
    );

    expect(missing).toEqual([]);
  });

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

async function readRuntimePublicApiNames(
  subpath: string
): Promise<ReadonlySet<string>> {
  const snapshotText = await readFile(
    fileURLToPath(new URL("../../public-api.snapshot.json", import.meta.url)),
    "utf8"
  );
  const snapshot = parseRuntimePublicApiSnapshot(JSON.parse(snapshotText));
  return new Set(
    (snapshot.surfaces[subpath] ?? []).map((entry) => {
      const separator = entry.indexOf(" ");
      return separator === -1 ? entry : entry.slice(separator + 1);
    })
  );
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

function parseRuntimePublicApiSnapshot(
  value: unknown
): RuntimePublicApiSnapshot {
  if (!(isRecord(value) && isRecord(value.surfaces))) {
    throw new TypeError("Expected runtime public API surfaces object");
  }
  const surfaces: Record<string, readonly string[]> = {};
  for (const [subpath, entries] of Object.entries(value.surfaces)) {
    if (!(Array.isArray(entries) && entries.every(isString))) {
      throw new TypeError(`Expected runtime public API array for ${subpath}`);
    }
    surfaces[subpath] = entries;
  }
  return { surfaces };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
