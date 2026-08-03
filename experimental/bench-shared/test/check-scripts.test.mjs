import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { checkNodeScripts } from "../src/check-scripts.mjs";

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pss-bench-check-"));
});

after(async () => {
  await rm(root, { force: true, recursive: true });
});

test("a package without one of the default directories still checks", async () => {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.mjs"), "export const ok = 1;\n");
  const checked = await checkNodeScripts({ packageRoot: root });
  assert.deepEqual(checked, ["src/index.mjs"]);
});
