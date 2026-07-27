import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";

export const MODEL_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
export const MODEL_CATALOG_CACHE_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const MODEL_CATALOG_CACHE_DIRECTORY_NAME = "model-catalogs";

const CACHE_VERSION = 1;
const CACHE_MAX_BYTES = 262_144;
const TRAILING_SLASHES_PATTERN = /\/+$/;
const CACHE_READ_FLAGS =
  constants.O_RDONLY + constants.O_NONBLOCK + constants.O_NOFOLLOW;

export interface ModelCatalogCacheEntry {
  readonly fetchedAt: number;
  readonly modelIds: readonly string[];
}

export interface ModelCatalogCacheOptions {
  /** Defaults to `~/.pss/model-catalogs`. */
  readonly directory?: string;
  /** Injectable for deterministic callers and tests. */
  readonly now?: () => number;
}

const cacheSchema = z.object({
  fetchedAt: z.number().int().nonnegative(),
  modelIds: z.array(z.string().min(1).max(512)).max(10_000),
  version: z.literal(CACHE_VERSION),
});

/**
 * Filesystem cache for OpenAI-compatible `/models` responses.
 *
 * The file identity is an opaque hash of the normalized endpoint and
 * credential. The cache payload contains only ids and a timestamp; no raw API
 * key or endpoint is written to disk. Atomic writes and no-follow reads keep
 * this best-effort cache safe to use under `~/.pss`.
 */
export class ModelCatalogCache {
  readonly #directory: string;
  readonly #now: () => number;

  constructor({
    directory = join(homedir(), ".pss", MODEL_CATALOG_CACHE_DIRECTORY_NAME),
    now = Date.now,
  }: ModelCatalogCacheOptions = {}) {
    this.#directory = directory;
    this.#now = now;
  }

  async read(
    baseURL: string,
    apiKey: string
  ): Promise<ModelCatalogCacheEntry | undefined> {
    const path = this.pathFor(baseURL, apiKey);
    try {
      const handle = await open(path, CACHE_READ_FLAGS);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > CACHE_MAX_BYTES) {
          return;
        }
        const buffer = Buffer.allocUnsafe(CACHE_MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            length,
            buffer.length - length,
            length
          );
          if (bytesRead === 0) {
            break;
          }
          length += bytesRead;
        }
        if (length > CACHE_MAX_BYTES) {
          return;
        }
        const parsed = cacheSchema.safeParse(
          JSON.parse(buffer.toString("utf8", 0, length))
        );
        if (!parsed.success) {
          return;
        }
        return {
          fetchedAt: parsed.data.fetchedAt,
          modelIds: parsed.data.modelIds,
        };
      } finally {
        await handle.close();
      }
    } catch {
      // A corrupt, absent, inaccessible, or swapped cache is never fatal.
      return;
    }
  }

  async write(
    baseURL: string,
    apiKey: string,
    modelIds: readonly string[]
  ): Promise<void> {
    const directory = this.#directory;
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    const path = this.pathFor(baseURL, apiKey);
    const temporaryPath = join(
      directory,
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
    );
    const payload = {
      fetchedAt: this.#now(),
      modelIds: [...modelIds],
      version: CACHE_VERSION,
    };
    try {
      await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  isFresh(entry: ModelCatalogCacheEntry): boolean {
    return isModelCatalogCacheFresh(entry, this.#now());
  }

  isUsableStale(entry: ModelCatalogCacheEntry): boolean {
    return isModelCatalogCacheUsableStale(entry, this.#now());
  }

  private pathFor(baseURL: string, apiKey: string): string {
    return join(
      this.#directory,
      `${modelCatalogCacheKey(baseURL, apiKey)}.json`
    );
  }
}

export const isModelCatalogCacheFresh = (
  entry: ModelCatalogCacheEntry,
  now: number,
  ttlMs: number = MODEL_CATALOG_CACHE_TTL_MS
): boolean => {
  const age = now - entry.fetchedAt;
  return age >= 0 && age < ttlMs;
};

export const isModelCatalogCacheUsableStale = (
  entry: ModelCatalogCacheEntry,
  now: number,
  maxStaleMs: number = MODEL_CATALOG_CACHE_MAX_STALE_MS
): boolean => {
  const age = now - entry.fetchedAt;
  return age >= 0 && age < maxStaleMs;
};

/** Opaque cache filename key; it never exposes an endpoint or credential. */
export const modelCatalogCacheKey = (baseURL: string, apiKey: string): string =>
  createHash("sha256")
    .update(`${baseURL.replace(TRAILING_SLASHES_PATTERN, "")}\0${apiKey}`)
    .digest("hex");
