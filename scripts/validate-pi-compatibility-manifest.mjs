import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const compatibilityDirectory = join(repoRoot, "docs/compatibility");
export const schemaPath = join(
  compatibilityDirectory,
  "pi-manifest.schema.json"
);

const VERSIONED_MANIFEST_PATTERN =
  /^pi-v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)\.json$/;

function compareManifestVersions(left, right) {
  const leftMatch = basename(left).match(VERSIONED_MANIFEST_PATTERN);
  const rightMatch = basename(right).match(VERSIONED_MANIFEST_PATTERN);
  if (!(leftMatch?.groups && rightMatch?.groups)) {
    throw new Error("Cannot compare invalid Pi compatibility manifest names");
  }

  for (const component of ["major", "minor", "patch"]) {
    const leftValue = BigInt(leftMatch.groups[component]);
    const rightValue = BigInt(rightMatch.groups[component]);
    if (leftValue < rightValue) {
      return -1;
    }
    if (leftValue > rightValue) {
      return 1;
    }
  }
  return 0;
}

export function discoverCompatibilityManifestPaths(
  directory = compatibilityDirectory
) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && VERSIONED_MANIFEST_PATTERN.test(entry.name)
    )
    .map((entry) => join(directory, entry.name))
    .sort(compareManifestVersions);
}

export function readCompatibilityFiles(
  manifestPath,
  directory = compatibilityDirectory
) {
  const resolvedManifestPath =
    manifestPath ?? discoverCompatibilityManifestPaths(directory).at(-1);
  if (resolvedManifestPath === undefined) {
    throw new Error("No versioned Pi compatibility manifests found");
  }

  return {
    manifest: JSON.parse(readFileSync(resolvedManifestPath, "utf8")),
    manifestPath: resolvedManifestPath,
    schema: JSON.parse(
      readFileSync(join(directory, "pi-manifest.schema.json"), "utf8")
    ),
  };
}

function isContainedPath(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

export function validateCompatibilityManifest({
  evidenceRoot = repoRoot,
  manifest,
  manifestPath,
  schema,
}) {
  const diagnosticManifestName =
    manifestPath === undefined
      ? "Pi compatibility manifest"
      : basename(manifestPath);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(manifest)) {
    const details = ajv.errorsText(validate.errors, { separator: "\n" });
    throw new Error(
      `${diagnosticManifestName} violates its schema:\n${details}`
    );
  }

  const expectedManifestName = `pi-${manifest.baseline.release}.json`;
  const manifestName =
    manifestPath === undefined ? expectedManifestName : diagnosticManifestName;
  if (manifestName !== expectedManifestName) {
    throw new Error(
      `${manifestName} does not match baseline release ${manifest.baseline.release}; expected ${expectedManifestName}`
    );
  }

  const ids = manifest.surfaces.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${manifestName} contains duplicate surface ids`);
  }

  const lexicalRoot = resolve(evidenceRoot);
  const canonicalRoot = realpathSync(lexicalRoot);
  const missingEvidence = [];
  for (const { evidence, id } of manifest.surfaces) {
    for (const path of evidence.local) {
      const candidate = resolve(lexicalRoot, path);
      if (isAbsolute(path) || !isContainedPath(lexicalRoot, candidate)) {
        throw new Error(
          `${manifestName} local evidence escapes repository root: ${id}: ${path}`
        );
      }
      if (!existsSync(candidate)) {
        missingEvidence.push(`${id}: ${path}`);
        continue;
      }
      if (!isContainedPath(canonicalRoot, realpathSync(candidate))) {
        throw new Error(
          `${manifestName} local evidence escapes repository root through a symlink: ${id}: ${path}`
        );
      }
    }
  }
  if (missingEvidence.length > 0) {
    throw new Error(
      `${manifestName} references missing local evidence:
${missingEvidence.join("\n")}`
    );
  }
}

export function validateCompatibilityManifests(
  directory = compatibilityDirectory
) {
  const manifestPaths = discoverCompatibilityManifestPaths(directory);
  if (manifestPaths.length === 0) {
    throw new Error("No versioned Pi compatibility manifests found");
  }

  for (const manifestPath of manifestPaths) {
    validateCompatibilityManifest(
      readCompatibilityFiles(manifestPath, directory)
    );
  }

  return manifestPaths;
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  const manifests = validateCompatibilityManifests();
  console.log(
    `Validated ${manifests.length} Pi compatibility manifest(s): ${manifests.map((path) => basename(path)).join(", ")}`
  );
}
