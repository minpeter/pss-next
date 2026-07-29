import { describe, expect, it } from "vitest";
import { configureBuildTemp } from "./build-temp";

describe("configureBuildTemp", () => {
  it("uses the PSS cache when no temp directory is configured", () => {
    const env: NodeJS.ProcessEnv = {};
    const created: string[] = [];

    const directory = configureBuildTemp({
      ensureDirectory: (path) => created.push(path),
      env,
      home: "/home/tester",
    });

    expect(directory).toBe("/home/tester/.cache/pss/build-tmp");
    expect(created).toEqual([directory]);
    expect(env).toMatchObject({
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    });
  });

  it("preserves an explicitly configured temp directory", () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: "/custom/tmp" };
    const created: string[] = [];

    const directory = configureBuildTemp({
      ensureDirectory: (path) => created.push(path),
      env,
      home: "/home/tester",
    });

    expect(directory).toBe("/custom/tmp");
    expect(created).toEqual([]);
    expect(env).toMatchObject({
      TEMP: "/custom/tmp",
      TMP: "/custom/tmp",
      TMPDIR: "/custom/tmp",
    });
  });
});
