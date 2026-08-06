import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "@babel/parser";

export const RUNTIME_API_SNAPSHOT_PATH = join(
  "packages",
  "runtime",
  "public-api.snapshot.json"
);

function compareCodeUnits(left, right) {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function declarationPath(packageDirectory, target) {
  const typesTarget = typeof target === "string" ? target : target.types;
  if (typeof typesTarget !== "string") {
    throw new Error("Runtime export does not have a types target");
  }
  return resolve(packageDirectory, typesTarget);
}

function exportedName(node) {
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "StringLiteral") {
    return node.value;
  }
  throw new Error(`Unsupported exported name node: ${node.type}`);
}

function directDeclarationExports(declaration) {
  if (
    declaration.type === "TSInterfaceDeclaration" ||
    declaration.type === "TSTypeAliasDeclaration"
  ) {
    return [`type ${declaration.id.name}`];
  }
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations.map(({ id }) => {
      if (id.type !== "Identifier") {
        throw new Error(
          "Destructured public variable declarations are unsupported"
        );
      }
      return `value ${id.name}`;
    });
  }
  if (
    declaration.type === "ClassDeclaration" ||
    declaration.type === "FunctionDeclaration" ||
    declaration.type === "TSDeclareFunction" ||
    declaration.type === "TSEnumDeclaration" ||
    declaration.type === "TSModuleDeclaration"
  ) {
    if (declaration.id?.type !== "Identifier") {
      throw new Error(`Unnamed public ${declaration.type} is unsupported`);
    }
    return [`value ${declaration.id.name}`];
  }
  throw new Error(`Unsupported public declaration node: ${declaration.type}`);
}

function addStatementExports(exports, statement, sourceName) {
  if (statement.type === "ExportDefaultDeclaration") {
    throw new Error(`${sourceName}: default exports are not supported`);
  }
  if (statement.type === "ExportAllDeclaration") {
    throw new Error(
      `${sourceName}: export star declarations are not supported`
    );
  }
  if (statement.type !== "ExportNamedDeclaration") {
    return;
  }
  if (statement.declaration) {
    for (const entry of directDeclarationExports(statement.declaration)) {
      exports.add(entry);
    }
  }
  for (const specifier of statement.specifiers) {
    if (specifier.type !== "ExportSpecifier") {
      throw new Error(
        `${sourceName}: ${specifier.type} declarations are not supported`
      );
    }
    const typeOnly =
      statement.exportKind === "type" || specifier.exportKind === "type";
    exports.add(
      `${typeOnly ? "type" : "value"} ${exportedName(specifier.exported)}`
    );
  }
}

export function declarationExportsFromText(text, sourceName = "declaration") {
  const program = parse(text, {
    allowUndeclaredExports: true,
    plugins: ["typescript"],
    sourceFilename: sourceName,
    sourceType: "module",
  }).program;
  const exports = new Set();
  for (const statement of program.body) {
    addStatementExports(exports, statement, sourceName);
  }
  return [...exports].sort(compareCodeUnits);
}

function declarationExports(file) {
  return declarationExportsFromText(readFileSync(file, "utf8"), file);
}

export function collectRuntimePublicApi(cwd = process.cwd()) {
  const packageDirectory = join(cwd, "packages", "runtime");
  const manifest = JSON.parse(
    readFileSync(join(packageDirectory, "package.json"), "utf8")
  );
  const entrypoints = Object.entries(manifest.exports)
    .filter(([, target]) =>
      typeof target === "string" ? target.endsWith(".d.ts") : target.types
    )
    .map(([subpath, target]) => [
      subpath,
      declarationPath(packageDirectory, target),
    ]);

  const missing = entrypoints
    .map(([, file]) => file)
    .filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `Build @minpeter/pss-runtime before checking its public API; missing ${missing.join(
        ", "
      )}`
    );
  }

  const surfaces = Object.fromEntries(
    entrypoints.map(([subpath, file]) => [subpath, declarationExports(file)])
  );

  return {
    schemaVersion: 1,
    package: manifest.name,
    surfaces: Object.fromEntries(
      Object.entries(surfaces).sort(([left], [right]) =>
        compareCodeUnits(left, right)
      )
    ),
  };
}

export function diffPublicApi(expected, actual) {
  const lines = [];
  const surfaceNames = new Set([
    ...Object.keys(expected.surfaces ?? {}),
    ...Object.keys(actual.surfaces ?? {}),
  ]);
  for (const surface of [...surfaceNames].sort((left, right) =>
    compareCodeUnits(left, right)
  )) {
    const expectedNames = new Set(expected.surfaces?.[surface] ?? []);
    const actualNames = new Set(actual.surfaces?.[surface] ?? []);
    for (const name of [...expectedNames]
      .filter((name) => !actualNames.has(name))
      .sort((left, right) => compareCodeUnits(left, right))) {
      lines.push(`- ${surface}: ${name}`);
    }
    for (const name of [...actualNames]
      .filter((name) => !expectedNames.has(name))
      .sort((left, right) => compareCodeUnits(left, right))) {
      lines.push(`+ ${surface}: ${name}`);
    }
  }
  return lines;
}

export function findRuntimePublicApiSnapshotErrors({ cwd, packages }) {
  if (!packages.includes("runtime")) {
    return [];
  }
  const snapshotFile = join(cwd, RUNTIME_API_SNAPSHOT_PATH);
  if (!existsSync(snapshotFile)) {
    return [`${RUNTIME_API_SNAPSHOT_PATH}: public API snapshot is missing`];
  }
  try {
    const expected = JSON.parse(readFileSync(snapshotFile, "utf8"));
    const actual = collectRuntimePublicApi(cwd);
    const diff = diffPublicApi(expected, actual);
    return diff.length === 0
      ? []
      : [
          `${RUNTIME_API_SNAPSHOT_PATH}: runtime public API changed:\n${diff.join(
            "\n"
          )}\nRun pnpm api:update after reviewing and documenting the change.`,
        ];
  } catch (error) {
    return [
      `${RUNTIME_API_SNAPSHOT_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

export function writeRuntimePublicApiSnapshot(cwd = process.cwd()) {
  const snapshotFile = join(cwd, RUNTIME_API_SNAPSHOT_PATH);
  const snapshot = collectRuntimePublicApi(cwd);
  writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshotFile;
}
