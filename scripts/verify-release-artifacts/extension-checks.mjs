import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  isRecord,
  packageDistPath,
  packageRootPath,
  readJsonForVerification,
  relativeToCwd,
} from "./shared.mjs";

const EXTENSION_CONTRACTS = {
  "extension-latex": {
    artifacts: ["index.js", "index.d.ts", "mathjax-worker.js"],
    name: "@minpeter/pss-extension-latex",
  },
  "extension-mermaid": {
    artifacts: ["index.js", "index.d.ts", "mermaid-art-worker.js"],
    name: "@minpeter/pss-extension-mermaid",
  },
  "extension-web": {
    artifacts: ["index.js", "index.d.ts"],
    name: "@minpeter/pss-extension-web",
  },
};

export function findExtensionArtifactErrors({ cwd, packages }) {
  const errors = [];

  for (const packageName of packages) {
    const contract = EXTENSION_CONTRACTS[packageName];
    if (!contract) {
      continue;
    }

    const packageRoot = packageRootPath(cwd, packageName);
    const packageJsonPath = join(packageRoot, "package.json");
    const packageJson = readJsonForVerification({ cwd, file: packageJsonPath });
    if (packageJson.error) {
      errors.push(packageJson.error);
    } else {
      const value = packageJson.value;
      const rootExport =
        isRecord(value) && isRecord(value.exports)
          ? value.exports["."]
          : undefined;
      if (
        !(
          isRecord(value) &&
          value.name === contract.name &&
          isRecord(rootExport) &&
          rootExport.import === "./dist/index.js" &&
          rootExport.types === "./dist/index.d.ts" &&
          Array.isArray(value.files) &&
          value.files.includes("dist")
        )
      ) {
        errors.push(
          `${relativeToCwd(cwd, packageJsonPath)}: invalid extension package contract`
        );
      }
    }

    const distPath = packageDistPath(cwd, packageName);
    if (!(existsSync(distPath) && statSync(distPath).isDirectory())) {
      continue;
    }
    for (const artifact of contract.artifacts) {
      const artifactPath = join(distPath, artifact);
      if (!existsSync(artifactPath)) {
        errors.push(
          `${relativeToCwd(cwd, artifactPath)} is missing; required extension artifact`
        );
      }
    }
  }

  return errors;
}
