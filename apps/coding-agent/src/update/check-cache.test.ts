import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isCacheFresh,
  parseUpdateCheckCache,
  readUpdateCheckCache,
  UPDATE_CHECK_TTL_MS,
  writeUpdateCheckCache,
} from "./check";

describe("update check cache", () => {
  it("round-trips a cache file written atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      const cachePath = join(directory, "update-check.json");
      const cache = {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.14", next: "0.0.14-next.3" },
      };

      await writeUpdateCheckCache(cachePath, cache);

      expect(await readUpdateCheckCache(cachePath)).toEqual(cache);
      expect(await readdir(directory)).toEqual(["update-check.json"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("creates the cache directory when missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      const cachePath = join(directory, "nested", "update-check.json");

      await writeUpdateCheckCache(cachePath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: {},
      });

      expect(await readUpdateCheckCache(cachePath)).toEqual({
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: {},
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("treats a missing cache file as absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      expect(
        await readUpdateCheckCache(join(directory, "update-check.json"))
      ).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects symbolic-link cache files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      const targetPath = join(directory, "target.json");
      const cachePath = join(directory, "update-check.json");
      await writeUpdateCheckCache(targetPath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.14" },
      });
      await symlink(targetPath, cachePath);

      expect(await readUpdateCheckCache(cachePath)).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects oversized cache files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      const cachePath = join(directory, "update-check.json");
      await writeFile(
        cachePath,
        JSON.stringify({
          checkedAt: "2026-07-21T00:00:00.000Z",
          tags: { ["x".repeat(65_536)]: "1.0.0" },
        })
      );

      expect(await readUpdateCheckCache(cachePath)).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "hardens cache directory and file permissions",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
      try {
        const cacheDirectory = join(directory, "nested");
        const cachePath = join(cacheDirectory, "update-check.json");
        await mkdir(cacheDirectory);
        await chmod(cacheDirectory, 0o777);

        await writeUpdateCheckCache(cachePath, {
          checkedAt: "2026-07-21T00:00:00.000Z",
          tags: {},
        });

        expect((await stat(cacheDirectory)).mode.toString(8).slice(-3)).toBe(
          "700"
        );
        expect((await stat(cachePath)).mode.toString(8).slice(-3)).toBe("600");
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
  );

  it("round-trips arbitrary channel tags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      const cachePath = join(directory, "update-check.json");
      const cache = {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { canary: "0.0.16-canary.2", beta: "1.0.0-beta.3" },
      };

      await writeUpdateCheckCache(cachePath, cache);

      expect(await readUpdateCheckCache(cachePath)).toEqual(cache);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("parses a serialized cache document", () => {
    const parsed = parseUpdateCheckCache(
      JSON.stringify({
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.14" },
      })
    );

    expect(parsed).toEqual({
      checkedAt: "2026-07-21T00:00:00.000Z",
      tags: { latest: "0.0.14" },
    });
  });

  it("rejects malformed cache documents", () => {
    expect(parseUpdateCheckCache("not json")).toBeUndefined();
    expect(parseUpdateCheckCache("{}")).toBeUndefined();
    expect(
      parseUpdateCheckCache('{"checkedAt":123,"tags":{}}')
    ).toBeUndefined();
    expect(
      parseUpdateCheckCache(
        '{"checkedAt":"2026-07-21T00:00:00.000Z","tags":{"latest":5}}'
      )
    ).toBeUndefined();
  });

  it("reads a corrupted cache file as absent instead of throwing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      const cachePath = join(directory, "update-check.json");
      await writeUpdateCheckCache(cachePath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: {},
      });
      await writeFile(cachePath, "{corrupted");

      expect(await readUpdateCheckCache(cachePath)).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("serializes concurrent writers without temporary-file collisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-update-check-"));
    try {
      const cachePath = join(directory, "update-check.json");
      const first = {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "1.0.0" },
      };
      const second = {
        checkedAt: "2026-07-21T00:00:01.000Z",
        tags: { latest: "1.0.1" },
      };

      await expect(
        Promise.all([
          writeUpdateCheckCache(cachePath, first),
          writeUpdateCheckCache(cachePath, second),
        ])
      ).resolves.toEqual([undefined, undefined]);
      expect([first, second]).toContainEqual(
        await readUpdateCheckCache(cachePath)
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("isCacheFresh", () => {
  const cache = {
    checkedAt: "2026-07-21T00:00:00.000Z",
    tags: {},
  };

  it("is fresh within the TTL and stale past it", () => {
    const checkedAtMs = Date.parse(cache.checkedAt);

    expect(isCacheFresh(cache, checkedAtMs + UPDATE_CHECK_TTL_MS - 1)).toBe(
      true
    );
    expect(isCacheFresh(cache, checkedAtMs + UPDATE_CHECK_TTL_MS + 1)).toBe(
      false
    );
  });

  it("treats a future-dated cache as stale so it gets refreshed", () => {
    const now = Date.parse("2026-07-21T00:00:00.000Z");
    const future = {
      checkedAt: "2026-07-22T00:00:00.000Z",
      tags: {},
    };

    expect(isCacheFresh(future, now)).toBe(false);
  });
});
