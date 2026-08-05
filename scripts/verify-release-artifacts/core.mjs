import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  findBundledExtensionImportLeaks,
  findExtensionlessRelativeImports,
  findMissingBundledExtensionWorkers,
  findPackageBinEntrypointErrors,
  findPublishedTestArtifacts,
  requirePackageDists,
} from "./package-checks.mjs";
import { findRuntimeDeclarationLeaks } from "./runtime-checks.mjs";
import { DEFAULT_PACKAGES } from "./shared.mjs";

export function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    packages: [...DEFAULT_PACKAGES],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--cwd") {
      options.cwd = resolve(argv.at(index + 1) ?? "");
      index += 1;
      continue;
    }

    if (arg === "--package") {
      const packageName = argv.at(index + 1);
      if (!packageName) {
        throw new Error("--package requires a package directory name");
      }
      if (options.packages.length === DEFAULT_PACKAGES.length) {
        options.packages = [];
      }
      options.packages.push(packageName);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function verifyReleaseArtifacts(options) {
  return [
    ...requirePackageDists(options),
    ...findPackageBinEntrypointErrors(options),
    ...findExtensionlessRelativeImports(options),
    ...findPublishedTestArtifacts(options),
    ...findRuntimeDeclarationLeaks(options),
    ...findMissingBundledExtensionWorkers(options),
    ...findBundledExtensionImportLeaks(options),
  ];
}

export function isMainModule(moduleUrl, argvPath = process.argv[1]) {
  return (
    argvPath !== undefined &&
    moduleUrl === pathToFileURL(resolve(argvPath)).href
  );
}

export function main() {
  const options = parseArgs(process.argv.slice(2));
  const errors = verifyReleaseArtifacts(options);

  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log("Release artifact verification passed");
}
