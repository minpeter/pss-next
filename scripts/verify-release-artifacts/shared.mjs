import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_PACKAGES = [
  "runtime",
  "coding-agent",
  "extension-latex",
  "extension-mermaid",
  "extension-web",
];
const PACKAGE_ROOTS = {
  "coding-agent": "apps/coding-agent",
  "extension-latex": "extensions/latex",
  "extension-mermaid": "extensions/mermaid",
  "extension-web": "extensions/web",
  runtime: "packages/runtime",
};

export function listFiles(root, predicate = () => true) {
  if (!existsSync(root)) {
    return [];
  }

  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

export function packageDistPath(cwd, packageName) {
  return join(packageRootPath(cwd, packageName), "dist");
}

export function packageRootPath(cwd, packageName) {
  const preferredRoot = join(
    cwd,
    PACKAGE_ROOTS[packageName] ?? join("packages", packageName)
  );
  if (existsSync(preferredRoot)) {
    return preferredRoot;
  }

  const legacyRoot = join(cwd, "packages", packageName);
  if (legacyRoot !== preferredRoot && existsSync(legacyRoot)) {
    return legacyRoot;
  }

  return preferredRoot;
}

export function readJsonForVerification({ cwd, file }) {
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return {
      error: `${relativeToCwd(cwd, file)}: cannot read package.json (${errorMessage(error)})`,
    };
  }
}

export function readTextForVerification(file) {
  try {
    return { value: readFileSync(file, "utf8") };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export function readModeForVerification(file) {
  try {
    return { value: statSync(file).mode };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function hasExecutablePermission(mode) {
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX file mode checks are the canonical use of execute-bit masks.
  return (mode & 0o111) !== 0;
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function relativeToCwd(cwd, file) {
  return file.startsWith(cwd) ? file.slice(cwd.length + 1) : file;
}
