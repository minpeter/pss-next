import { describe, expect, it } from "vitest";
import { writeUpdateCheckCache } from "./check";
import { emitUpdateNotice, isUpdateCheckDisabled } from "./notifier";
import { withTempCache } from "./notifier.test-harness";

describe("isUpdateCheckDisabled", () => {
  it("is disabled by explicit opt-out values", () => {
    expect(isUpdateCheckDisabled({ PSS_DISABLE_UPDATE_CHECK: "1" })).toBe(true);
    expect(isUpdateCheckDisabled({ PSS_DISABLE_UPDATE_CHECK: "true" })).toBe(
      true
    );
    expect(isUpdateCheckDisabled({ PSS_DISABLE_UPDATE_CHECK: "TRUE" })).toBe(
      true
    );
  });

  it("stays enabled for unset or other values", () => {
    expect(isUpdateCheckDisabled({})).toBe(false);
    expect(isUpdateCheckDisabled({ PSS_DISABLE_UPDATE_CHECK: "0" })).toBe(
      false
    );
    expect(isUpdateCheckDisabled({ PSS_DISABLE_UPDATE_CHECK: "yes" })).toBe(
      false
    );
  });
});

describe("emitUpdateNotice", () => {
  it(
    "stays silent for a dev build without a baked version",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: {},
        version: undefined,
        cachePath,
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(lines).toEqual([]);
      expect(tasks).toEqual([]);
    })
  );

  it(
    "stays silent when the kill switch is set",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      await writeUpdateCheckCache(cachePath, {
        checkedAt: new Date().toISOString(),
        tags: { latest: "99.0.0" },
      });

      await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: { PSS_DISABLE_UPDATE_CHECK: "1" },
        version: "0.0.13",
        cachePath,
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(lines).toEqual([]);
      expect(tasks).toEqual([]);
    })
  );

  it(
    "writes the cached notice and skips the refresh when the cache is fresh",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      const now = Date.parse("2026-07-21T00:00:00.000Z");
      await writeUpdateCheckCache(cachePath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.14" },
      });

      await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: {},
        version: "0.0.13",
        cachePath,
        now: () => now,
        fetchTags: () => Promise.reject(new Error("must not fetch")),
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("0.0.13");
      expect(lines[0]).toContain("0.0.14");
      expect(tasks).toEqual([]);
    })
  );

  it(
    "returns the notice it wrote and undefined when silent",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      const now = Date.parse("2026-07-21T00:00:00.000Z");
      await writeUpdateCheckCache(cachePath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.14" },
      });

      const noticed = await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: {},
        version: "0.0.13",
        cachePath,
        now: () => now,
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(noticed).toEqual({
        kind: "channel-update",
        channel: "latest",
        currentVersion: "0.0.13",
        latestVersion: "0.0.14",
      });

      const silent = await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: { PSS_DISABLE_UPDATE_CHECK: "1" },
        version: "0.0.13",
        cachePath,
        now: () => now,
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(silent).toBeUndefined();
    })
  );

  it(
    "writes nothing when the cached version is current",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      const now = Date.parse("2026-07-21T00:00:00.000Z");
      await writeUpdateCheckCache(cachePath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.13" },
      });

      await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: {},
        version: "0.0.13",
        cachePath,
        now: () => now,
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(lines).toEqual([]);
      expect(tasks).toEqual([]);
    })
  );

  it(
    "announces a stable release that surpasses a next-channel install",
    withTempCache(async ({ cachePath, lines, tasks }) => {
      const now = Date.parse("2026-07-21T00:00:00.000Z");
      await writeUpdateCheckCache(cachePath, {
        checkedAt: "2026-07-21T00:00:00.000Z",
        tags: { latest: "0.0.14", next: "0.0.14-next.2" },
      });

      await emitUpdateNotice({
        write: (line) => lines.push(line),
        env: {},
        version: "0.0.14-next.2",
        cachePath,
        now: () => now,
        schedule: (task) => {
          tasks.push(task);
        },
      });

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("0.0.14");
      expect(lines[0]).toContain("--channel latest");
      expect(tasks).toEqual([]);
    })
  );
});
