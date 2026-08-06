import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const manifestPath = join(
  repoRoot,
  "docs/compatibility/pi-v0.83.0.json"
);
export const schemaPath = join(
  repoRoot,
  "docs/compatibility/pi-manifest.schema.json"
);

export function readCompatibilityFiles() {
  return {
    manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
    schema: JSON.parse(readFileSync(schemaPath, "utf8")),
  };
}

export function validateCompatibilityManifest({ manifest, schema }) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(manifest)) {
    const details = ajv.errorsText(validate.errors, { separator: "\n" });
    throw new Error(
      `Pi compatibility manifest violates its schema:\n${details}`
    );
  }

  const ids = manifest.surfaces.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Pi compatibility manifest contains duplicate surface ids");
  }

  const missingEvidence = manifest.surfaces.flatMap(({ evidence, id }) =>
    evidence.local
      .filter((path) => !existsSync(join(repoRoot, path)))
      .map((path) => `${id}: ${path}`)
  );
  if (missingEvidence.length > 0) {
    throw new Error(
      `Pi compatibility manifest references missing local evidence:\n${missingEvidence.join("\n")}`
    );
  }
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  validateCompatibilityManifest(readCompatibilityFiles());
  console.log("Pi v0.83.0 compatibility manifest is valid.");
}
