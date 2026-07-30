import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }
  return result.stdout;
}

const WORKSPACE_RANGE_PREFIX = "workspace:";

/**
 * Workspace dependencies are not published to the registry, so a plain
 * `pnpm pack` produces a tarball whose `workspace:^` ranges resolve to
 * registry versions that either do not exist or predate the packed agent.
 * Pack each workspace dependency in the closure and rewrite the range to an
 * absolute `file:` specifier under {@link vendorDirectory}, which the sandbox
 * setup unpacks next to the agent tarball before `npm install -g` runs.
 */
async function vendorWorkspaceDependencies({
  agentPackageDirectory,
  repositoryRoot,
  vendorDirectory,
}) {
  const manifests = new Map(
    JSON.parse(
      run(
        "pnpm",
        ["list", "--recursive", "--depth", "-1", "--json"],
        repositoryRoot
      )
    ).map((entry) => [entry.name, entry.path])
  );
  const vendored = {};
  const pending = [agentPackageDirectory];
  const packed = new Set();
  while (pending.length > 0) {
    const directory = pending.pop();
    const manifest = JSON.parse(
      await readFile(resolve(directory, "package.json"), "utf8")
    );
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (!range.startsWith(WORKSPACE_RANGE_PREFIX) || packed.has(name)) {
        continue;
      }
      const dependencyDirectory = manifests.get(name);
      if (dependencyDirectory === undefined) {
        throw new Error(
          `Workspace dependency ${name} of ${manifest.name} is not a workspace package.`
        );
      }
      packed.add(name);
      const before = new Set(await readdir(vendorDirectory));
      run(
        "pnpm",
        ["pack", "--pack-destination", vendorDirectory],
        dependencyDirectory
      );
      const tarball = (await readdir(vendorDirectory)).find(
        (entry) => !before.has(entry)
      );
      if (tarball === undefined) {
        throw new Error(`pnpm pack produced no tarball for ${name}.`);
      }
      vendored[name] = tarball;
      pending.push(dependencyDirectory);
    }
  }
  return vendored;
}

/**
 * Rewrite the packed agent manifest's workspace ranges to the vendored
 * tarballs and repack. Rewriting inside the tarball keeps the workspace
 * manifests untouched.
 */
async function rewriteVendoredRanges({
  sandboxVendorDirectory,
  stableTarball,
  vendored,
  workingDirectory,
}) {
  const extracted = resolve(workingDirectory, "extracted");
  await mkdir(extracted, { recursive: true });
  run("tar", ["-xzf", stableTarball, "-C", extracted], workingDirectory);
  const manifestPath = resolve(extracted, "package/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const [name, tarball] of Object.entries(vendored)) {
    if (manifest.dependencies?.[name] === undefined) {
      continue;
    }
    manifest.dependencies[name] =
      `file:${join(sandboxVendorDirectory, tarball)}`;
  }
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  await rm(stableTarball, { force: true });
  run("tar", ["-czf", stableTarball, "package"], extracted);
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
  sandboxVendorDirectory = "/tmp/pss-vendor",
  stableTarballName,
}) {
  const artifactsDirectory = resolve(benchmarkRoot, ".artifacts");
  const stableTarball = resolve(artifactsDirectory, stableTarballName);
  const vendorDirectory = resolve(artifactsDirectory, "vendor");

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
  await rm(vendorDirectory, { force: true, recursive: true });
  await mkdir(vendorDirectory, { recursive: true });
  // Build the whole workspace closure: vendored dependencies are packed from
  // their `dist` output, so an agent-only build would ship stale artifacts.
  run("pnpm", ["--filter", `${packageFilter}...`, "build"], repositoryRoot);
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
  const vendored = await vendorWorkspaceDependencies({
    agentPackageDirectory: packageDirectory,
    repositoryRoot,
    vendorDirectory,
  });
  const workingDirectory = await mkdtemp(join(tmpdir(), "pss-pack-"));
  try {
    await rewriteVendoredRanges({
      sandboxVendorDirectory,
      stableTarball,
      vendored,
      workingDirectory,
    });
  } finally {
    await rm(workingDirectory, { force: true, recursive: true });
  }
  const content = await readFile(stableTarball);
  const manifest = {
    package: agentPackage.name,
    sha256: createHash("sha256").update(content).digest("hex"),
    vendored,
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
