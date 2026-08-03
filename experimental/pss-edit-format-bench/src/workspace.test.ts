import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { verifyWorkspace, type WorkspaceFileSet } from "./workspace";

const createWorkspace = async (files: WorkspaceFileSet): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pss-workspace-test-"));
  onTestFinished(() => rm(root, { force: true, recursive: true }));
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const absolutePath = join(root, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    })
  );
  return root;
};

describe("exact workspace verification", () => {
  const initial = {
    "src/main.ts": 'import { value } from "./value";\nconsole.log(value);\n',
    "src/value.ts": "export const value = 1;\n",
  };
  const expected = {
    ...initial,
    "src/value.ts": "export const value = 2;\n",
  };

  it("passes an exact multi-file workspace", async () => {
    const root = await createWorkspace(expected);

    const result = await verifyWorkspace(root, initial, expected);

    expect(result).toMatchObject({
      changedFiles: ["src/value.ts"],
      diagnostics: [],
      passed: true,
    });
  });

  it("reports a missing expected file", async () => {
    const root = await createWorkspace({
      "src/main.ts": expected["src/main.ts"],
    });

    const result = await verifyWorkspace(root, initial, expected);

    expect(result).toMatchObject({
      diagnostics: ["missing expected file: src/value.ts"],
      passed: false,
    });
  });

  it("reports an unexpected extra file", async () => {
    const root = await createWorkspace({
      ...expected,
      "debug.log": "unexpected\n",
    });

    const result = await verifyWorkspace(root, initial, expected);

    expect(result).toMatchObject({
      diagnostics: ["unexpected file: debug.log"],
      passed: false,
    });
  });

  it("reports an unintended change in a non-target file", async () => {
    const root = await createWorkspace({
      ...expected,
      "src/main.ts":
        'import { value } from "./value";\nconsole.log(value + 1);\n',
    });

    const result = await verifyWorkspace(root, initial, expected);

    expect(result).toMatchObject({
      diagnostics: ["content mismatch: src/main.ts"],
      passed: false,
    });
  });
});
