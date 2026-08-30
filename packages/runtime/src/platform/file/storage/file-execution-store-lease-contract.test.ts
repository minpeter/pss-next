import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach } from "vitest";
import { describeExecutionLeaseContract } from "../../../contracts/execution-store/lease-contract";
import { FileExecutionStore } from "./file-execution-store";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

describeExecutionLeaseContract("FileExecutionStore", () => {
  const root = join("/var/tmp", `pss-file-lease-${crypto.randomUUID()}`);
  dirs.push(root);
  const directory = join(root, "store");
  return new FileExecutionStore(directory);
});
