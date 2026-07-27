import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MODEL_CATALOG_CACHE_MAX_STALE_MS,
  MODEL_CATALOG_CACHE_TTL_MS,
  ModelCatalogCache,
  modelCatalogCacheKey,
} from "./model-catalog-cache";

const directories: string[] = [];

const createCache = async (now = 1_000_000) => {
  const directory = await mkdtemp(join(tmpdir(), "pss-model-catalog-cache-"));
  directories.push(directory);
  return {
    cache: new ModelCatalogCache({ directory, now: () => now }),
    directory,
  };
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("ModelCatalogCache", () => {
  it("round-trips a catalog atomically without persisting endpoint or credential", async () => {
    const { cache, directory } = await createCache();
    const baseURL = "https://provider.example/v1/";
    const apiKey = "secret-api-key";

    await cache.write(baseURL, apiKey, ["model-a", "model-b"]);

    await expect(cache.read(baseURL, apiKey)).resolves.toEqual({
      fetchedAt: 1_000_000,
      modelIds: ["model-a", "model-b"],
    });
    const [name] = await readdir(directory);
    expect(name).toBe(`${modelCatalogCacheKey(baseURL, apiKey)}.json`);
    expect(name).not.toContain("provider");
    expect(name).not.toContain("secret");
    expect(
      (await stat(join(directory, name ?? ""))).mode.toString(8).slice(-3)
    ).toBe("600");
  });

  it("rejects an oversized catalog before creating a cache file", async () => {
    const { cache, directory } = await createCache();

    await expect(
      cache.write("https://provider.example/v1", "secret", [
        "x".repeat(300_000),
      ])
    ).rejects.toThrow("exceeds the size limit");
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("ignores a corrupt cache entry", async () => {
    const { cache, directory } = await createCache();
    const baseURL = "https://provider.example/v1";
    const apiKey = "secret-api-key";
    await writeFile(
      join(directory, `${modelCatalogCacheKey(baseURL, apiKey)}.json`),
      "{corrupt"
    );

    await expect(cache.read(baseURL, apiKey)).resolves.toBeUndefined();
  });

  it("distinguishes fresh and usable-stale catalogs", async () => {
    const { cache } = await createCache(10_000_000);
    const fresh = {
      fetchedAt: 10_000_000 - MODEL_CATALOG_CACHE_TTL_MS + 1,
      modelIds: ["model-a"],
    };
    const stale = {
      fetchedAt: 10_000_000 - MODEL_CATALOG_CACHE_TTL_MS,
      modelIds: ["model-a"],
    };
    const expired = {
      fetchedAt: 10_000_000 - MODEL_CATALOG_CACHE_MAX_STALE_MS,
      modelIds: ["model-a"],
    };

    expect(cache.isFresh(fresh)).toBe(true);
    expect(cache.isUsableStale(fresh)).toBe(true);
    expect(cache.isFresh(stale)).toBe(false);
    expect(cache.isUsableStale(stale)).toBe(true);
    expect(cache.isUsableStale(expired)).toBe(false);
  });
});
