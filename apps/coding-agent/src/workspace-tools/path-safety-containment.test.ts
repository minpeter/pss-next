import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertWorkspacePathContained,
  resolveWorkspacePath,
} from "./path-safety";
import { atomicWrite } from "./write-file";

const OUTSIDE_WORKSPACE_MESSAGE = /outside the workspace/;

let workspace: string;
let outside: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pss-ws-"));
  outside = await mkdtemp(join(tmpdir(), "pss-out-"));
  await mkdir(join(workspace, "sub"), { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function swapSubForOutsideLink(): Promise<void> {
  await rename(join(workspace, "sub"), join(workspace, "sub-real"));
  await symlink(outside, join(workspace, "sub"));
}

describe("workspace containment at mutation time", () => {
  it("rejects an atomic write after an intermediate directory is swapped for an escaping symlink", async () => {
    await writeFile(join(workspace, "sub", "target.txt"), "original");
    const resolved = await resolveWorkspacePath(workspace, "sub/target.txt");
    await swapSubForOutsideLink();

    await expect(
      atomicWrite(resolved.root, resolved.path, "pwned")
    ).rejects.toThrow(OUTSIDE_WORKSPACE_MESSAGE);
    await expect(
      readFile(join(outside, "target.txt"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes for an untouched resolved path", async () => {
    await writeFile(join(workspace, "sub", "ok.txt"), "data");
    const resolved = await resolveWorkspacePath(workspace, "sub/ok.txt");
    await expect(
      assertWorkspacePathContained(resolved.root, resolved.path)
    ).resolves.toBeUndefined();
  });

  it("throws after a swap even when the escaped target exists", async () => {
    await writeFile(join(workspace, "sub", "victim.txt"), "inside");
    await writeFile(join(outside, "victim.txt"), "outside");
    const resolved = await resolveWorkspacePath(workspace, "sub/victim.txt");
    await swapSubForOutsideLink();
    await expect(
      assertWorkspacePathContained(resolved.root, resolved.path)
    ).rejects.toThrow(OUTSIDE_WORKSPACE_MESSAGE);
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("outside");
  });

  it("honors no-follow for a final symlink whose parent is swapped", async () => {
    await symlink(
      join(workspace, "sub-real-target"),
      join(workspace, "sub", "link.txt")
    );
    const resolved = await resolveWorkspacePath(workspace, "sub/link.txt", {
      followFinalSymlink: false,
    });
    await swapSubForOutsideLink();
    await expect(
      assertWorkspacePathContained(resolved.root, resolved.path, {
        followFinalSymlink: false,
      })
    ).rejects.toThrow(OUTSIDE_WORKSPACE_MESSAGE);
  });

  it("accepts a no-follow final symlink that is untouched", async () => {
    await symlink(
      join(workspace, "sub-real-target"),
      join(workspace, "sub", "link.txt")
    );
    const resolved = await resolveWorkspacePath(workspace, "sub/link.txt", {
      followFinalSymlink: false,
    });
    await expect(
      assertWorkspacePathContained(resolved.root, resolved.path, {
        followFinalSymlink: false,
      })
    ).resolves.toBeUndefined();
  });
});
