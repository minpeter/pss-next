import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CodingAgentExtension,
  CodingAgentExtensionFactory,
  CodingAgentExtensionInput,
  ExtensionJsonValue,
} from "../types";
import {
  ensureReloadModuleGraphHooks,
  purgeCommonJsCacheUnder,
} from "./reload-module-graph";
import type { ExtensionTarget, ImportExtensionModule } from "./types";

const defaultImportModule: ImportExtensionModule = async (specifier) =>
  await import(specifier);
const PACKAGE_NAME_PATTERN =
  /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/;

export async function loadExtensionTarget({
  cacheBust,
  config,
  id,
  importer = defaultImportModule,
  installRoot,
  target,
}: {
  readonly cacheBust?: string;
  readonly config?: Readonly<Record<string, ExtensionJsonValue>>;
  readonly id: string;
  readonly importer?: ImportExtensionModule;
  readonly installRoot: string;
  readonly target: ExtensionTarget;
}): Promise<CodingAgentExtensionInput> {
  const entryPath =
    target.kind === "module"
      ? target.path
      : await resolvePackageImportEntry(installRoot, target.packageName);
  const url = pathToFileURL(entryPath);
  if (cacheBust !== undefined) {
    url.searchParams.set("pss-extension-update", cacheBust);
    ensureReloadModuleGraphHooks();
    purgeCommonJsCacheUnder([installRoot, dirname(entryPath)]);
  }
  const specifier = url.href;
  const namespace = await importer(specifier);
  const candidate =
    isRecord(namespace) && "default" in namespace
      ? namespace.default
      : namespace;
  if (isExtensionFactory(candidate)) {
    return {
      ...(config === undefined ? {} : { config }),
      default: candidate,
      id,
    };
  }
  if (isCodingAgentExtension(candidate)) {
    if (candidate.id !== id) {
      throw new TypeError(
        `Coding agent extension "${id}" exports conflicting id "${candidate.id}"`
      );
    }
    return {
      ...candidate,
      ...(config === undefined
        ? {}
        : {
            config: {
              ...candidate.config,
              ...config,
            },
          }),
    };
  }
  throw new TypeError(
    `Coding agent extension "${id}" default export must be a function`
  );
}

async function resolvePackageImportEntry(
  installRoot: string,
  packageName: string
): Promise<string> {
  if (!isPackageName(packageName)) {
    throw new TypeError(`Invalid extension package name: ${packageName}`);
  }
  const packageRoot = join(
    installRoot,
    "node_modules",
    ...packageName.split("/")
  );
  const value: unknown = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8")
  );
  if (!isRecord(value)) {
    throw new TypeError(`Invalid package.json for extension "${packageName}"`);
  }
  const hasExports = "exports" in value;
  const rawEntry = hasExports
    ? resolveRootExport(value.exports)
    : (stringProperty(value, "module") ??
      stringProperty(value, "main") ??
      "./index.js");
  const entry = normalizePackageEntry(rawEntry, hasExports);
  if (entry === undefined) {
    throw new TypeError(
      `Extension package "${packageName}" has no import-compatible root export`
    );
  }
  const resolved = resolve(packageRoot, entry);
  const packageRelativePath = relative(packageRoot, resolved);
  if (packageRelativePath.startsWith("..") || isAbsolute(packageRelativePath)) {
    throw new TypeError(
      `Extension package "${packageName}" export escapes its package root`
    );
  }
  return resolved;
}

function normalizePackageEntry(
  entry: string | undefined,
  fromExports: boolean
): string | undefined {
  if (entry === undefined || isAbsolute(entry)) {
    return;
  }
  if (fromExports) {
    return entry.startsWith("./") ? entry : undefined;
  }
  return entry.startsWith("./") ? entry : `./${entry}`;
}

function resolveRootExport(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const resolved = resolveRootExport(candidate);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if ("." in value) {
    return resolveRootExport(value["."]);
  }
  for (const [condition, candidate] of Object.entries(value)) {
    if (
      condition === "import" ||
      condition === "node" ||
      condition === "default"
    ) {
      const resolved = resolveRootExport(candidate);
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }
}

function stringProperty(
  value: Readonly<Record<string, unknown>>,
  property: string
): string | undefined {
  const candidate = value[property];
  return typeof candidate === "string" ? candidate : undefined;
}

function isPackageName(value: string): boolean {
  return PACKAGE_NAME_PATTERN.test(value);
}

function isExtensionFactory(
  value: unknown
): value is CodingAgentExtensionFactory {
  return typeof value === "function";
}

function isCodingAgentExtension(value: unknown): value is CodingAgentExtension {
  return (
    isRecord(value) &&
    "id" in value &&
    typeof value.id === "string" &&
    "configure" in value &&
    typeof value.configure === "function"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object";
}
