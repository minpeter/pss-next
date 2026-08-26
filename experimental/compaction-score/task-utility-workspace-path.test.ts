import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validatedTaskEvidenceFile,
  validatedTaskWorkspacePath,
} from "./task-utility-workspace-path";

const temporaryDirectories: string[] = [];

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), name));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("task utility workspace evidence path", () => {
  it("accepts a real workspace below the artifact output", async () => {
    const output = await temporaryRoot("task-workspace-output-");
    const workspace = join(output, "workspaces", "fixture", "r1", "full");
    await mkdir(workspace, { recursive: true });

    await expect(
      validatedTaskWorkspacePath(join(output, "task-utility.json"), workspace)
    ).resolves.toBe(workspace);
  });

  it("rejects a symlink escaping the artifact output", async () => {
    const output = await temporaryRoot("task-workspace-output-");
    const external = await temporaryRoot("task-workspace-external-");
    const workspaces = join(output, "workspaces");
    await mkdir(workspaces, { recursive: true });
    const linked = join(workspaces, "linked");
    await symlink(external, linked, "dir");

    await expect(
      validatedTaskWorkspacePath(join(output, "task-utility.json"), linked)
    ).rejects.toThrow("outside the artifact output");
  });

  it("rejects a symlinked workspace root", async () => {
    const output = await temporaryRoot("task-workspace-output-");
    const external = await temporaryRoot("task-workspace-external-");
    await symlink(external, join(output, "workspaces"), "dir");
    const workspace = join(external, "fixture");
    await mkdir(workspace);

    await expect(
      validatedTaskWorkspacePath(join(output, "task-utility.json"), workspace)
    ).rejects.toThrow("root must not be a symlink");
  });
  it("rejects a symlinked workspace receipt", async () => {
    const output = await temporaryRoot("task-workspace-output-");
    const external = await temporaryRoot("task-workspace-external-");
    const workspace = join(output, "workspaces", "fixture");
    await mkdir(workspace, { recursive: true });
    const externalReceipt = join(external, "receipt.json");
    await writeFile(externalReceipt, "{}");
    await symlink(
      externalReceipt,
      join(workspace, "task-utility-receipt.json")
    );

    await expect(
      validatedTaskEvidenceFile(workspace, "task-utility-receipt.json")
    ).rejects.toThrow("must not be a symlink");
  });
});
