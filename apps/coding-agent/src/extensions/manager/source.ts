import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export type ParsedExtensionSource =
  | {
      readonly kind: "module";
      readonly path: string;
      readonly requested: string;
    }
  | {
      readonly installSpec: string;
      readonly kind: "package";
      readonly packageName?: string;
      readonly requested: string;
      readonly sourceKind: "git" | "local" | "npm";
    };

export async function parseExtensionSource(
  requested: string,
  cwd: string
): Promise<ParsedExtensionSource> {
  const source = requested.trim();
  if (source.length === 0) {
    throw new TypeError("Extension source must not be empty");
  }
  if (isLocalSource(source)) {
    return await parseLocalSource(source, cwd);
  }
  if (isGitSource(source)) {
    return {
      installSpec: source,
      kind: "package",
      requested,
      sourceKind: "git",
    };
  }
  const installSpec = source.startsWith("npm:") ? source.slice(4) : source;
  return {
    installSpec,
    kind: "package",
    packageName: packageNameFromNpmSpec(installSpec),
    requested,
    sourceKind: "npm",
  };
}

async function parseLocalSource(
  source: string,
  cwd: string
): Promise<ParsedExtensionSource> {
  const withoutPrefix = source.startsWith("file:") ? source.slice(5) : source;
  const path = isAbsolute(withoutPrefix)
    ? withoutPrefix
    : resolve(cwd, withoutPrefix);
  const details = await stat(path);
  if (details.isFile()) {
    if (!(path.endsWith(".js") || path.endsWith(".mjs"))) {
      throw new TypeError("Local extension modules must end in .js or .mjs");
    }
    return { kind: "module", path, requested: source };
  }
  if (!details.isDirectory()) {
    throw new TypeError(`Unsupported local extension source: ${source}`);
  }
  return {
    installSpec: path,
    kind: "package",
    packageName: await packageNameFromDirectory(path),
    requested: source,
    sourceKind: "local",
  };
}

async function packageNameFromDirectory(path: string): Promise<string> {
  const value: unknown = JSON.parse(
    await readFile(resolve(path, "package.json"), "utf8")
  );
  if (
    value === null ||
    typeof value !== "object" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0
  ) {
    throw new TypeError(`Extension package at ${path} has no package name`);
  }
  return value.name;
}

function packageNameFromNpmSpec(spec: string): string {
  if (spec.startsWith("@")) {
    const separator = spec.indexOf("@", spec.indexOf("/") + 1);
    return separator === -1 ? spec : spec.slice(0, separator);
  }
  const separator = spec.indexOf("@");
  return separator === -1 ? spec : spec.slice(0, separator);
}

function isLocalSource(source: string): boolean {
  return (
    source.startsWith(".") ||
    source.startsWith("/") ||
    source.startsWith("file:")
  );
}

function isGitSource(source: string): boolean {
  return (
    source.startsWith("git+") ||
    source.startsWith("git@") ||
    source.startsWith("github:") ||
    source.startsWith("ssh://") ||
    (source.startsWith("https://") && source.includes(".git"))
  );
}
