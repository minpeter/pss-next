import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }
}

/**
 * Build an agent workspace package and pack it into a stable-named tarball
 * under the benchmark's .artifacts directory, with a sha256 manifest so a
 * campaign can prove exactly which agent code ran.
 */
export async function packAgentArtifact({
  benchmarkRoot,
  packageDirectory,
  packageFilter,
  repositoryRoot,
  stableTarballName,
}) {
  const artifactsDirectory = resolve(benchmarkRoot, ".artifacts");
  const stableTarball = resolve(artifactsDirectory, stableTarballName);

  // Read at runtime instead of a JSON module import: static imports crossing
  // the package boundary fail the repo's turbo boundaries check.
  const agentPackage = JSON.parse(
    await readFile(resolve(packageDirectory, "package.json"), "utf8")
  );

  await mkdir(artifactsDirectory, { recursive: true });
  await Promise.all(
    (await readdir(artifactsDirectory))
      .filter((entry) => entry.endsWith(".tgz"))
      .map((entry) => rm(resolve(artifactsDirectory, entry), { force: true }))
  );
  run("pnpm", ["--filter", packageFilter, "build"], repositoryRoot);
  run(
    "pnpm",
    ["pack", "--pack-destination", artifactsDirectory],
    packageDirectory
  );
  const tarballs = (await readdir(artifactsDirectory)).filter((entry) =>
    entry.endsWith(".tgz")
  );
  if (tarballs.length !== 1) {
    throw new Error(`Expected one agent tarball, found ${tarballs.length}.`);
  }
  await rename(resolve(artifactsDirectory, tarballs[0]), stableTarball);
  const content = await readFile(stableTarball);
  const manifest = {
    package: agentPackage.name,
    sha256: createHash("sha256").update(content).digest("hex"),
    version: agentPackage.version,
  };
  await writeFile(
    resolve(artifactsDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  process.stdout.write(
    `Packed ${manifest.package}@${manifest.version} (${manifest.sha256.slice(0, 12)}).\n`
  );
  return manifest;
}
