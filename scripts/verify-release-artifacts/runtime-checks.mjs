import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FORBIDDEN_RUNTIME_MODEL_ADAPTER_NAMES,
  FORBIDDEN_RUNTIME_PUBLIC_PATTERNS,
  FORBIDDEN_RUNTIME_ROOT_NAMES,
  FORBIDDEN_RUNTIME_SUBAGENT_NAMES,
  REQUIRED_RUNTIME_CHANNEL_EXPORTS,
  REQUIRED_RUNTIME_CLOUDFLARE_EXPORTS,
  REQUIRED_RUNTIME_DURABLE_OBJECT_EXPORTS,
  REQUIRED_RUNTIME_EXECUTION_EXPORTS,
  REQUIRED_RUNTIME_FILE_EXPORTS,
  REQUIRED_RUNTIME_MEMORY_EXPORTS,
  REQUIRED_RUNTIME_OTEL_EXPORTS,
  REQUIRED_RUNTIME_ROOT_EXPORTS,
} from "./runtime-public-surface.mjs";
import { listFiles, packageDistPath, relativeToCwd } from "./shared.mjs";

const RUNTIME_PUBLIC_ARTIFACT_RE = /\.(?:d\.ts|[cm]?js)$/;

export function findRuntimeDeclarationLeaks({ cwd, packages }) {
  if (!packages.includes("runtime")) {
    return [];
  }

  return [
    ...findRuntimeDeclarationExportLeaks({
      cwd,
      file: join(packageDistPath(cwd, "runtime"), "index.d.ts"),
      requiredExports: REQUIRED_RUNTIME_ROOT_EXPORTS,
      surface: "root",
    }),
    ...findRuntimeDeclarationExportLeaks({
      cwd,
      file: join(packageDistPath(cwd, "runtime"), "channel", "index.d.ts"),
      requiredExports: REQUIRED_RUNTIME_CHANNEL_EXPORTS,
      surface: "channel",
    }),
    ...findRuntimeDeclarationExportLeaks({
      cwd,
      file: join(packageDistPath(cwd, "runtime"), "execution", "index.d.ts"),
      requiredExports: REQUIRED_RUNTIME_EXECUTION_EXPORTS,
      surface: "execution",
    }),
    ...findRuntimeDeclarationExportLeaks({
      cwd,
      file: join(
        packageDistPath(cwd, "runtime"),
        "platform",
        "memory",
        "index.d.ts"
      ),
      requiredExports: REQUIRED_RUNTIME_MEMORY_EXPORTS,
      surface: "memory",
    }),
    ...findRuntimeDeclarationExportLeaks({
      cwd,
      file: join(
        packageDistPath(cwd, "runtime"),
        "platform",
        "durable-object",
        "host",
        "storage-host.d.ts"
      ),
      requiredExports: REQUIRED_RUNTIME_DURABLE_OBJECT_EXPORTS,
      surface: "durable object",
    }),
    ...findRuntimeDeclarationExportLeaks({
      cwd,
      file: join(
        packageDistPath(cwd, "runtime"),
        "platform",
        "durable-object",
        "cloudflare",
        "agents",
        "index.d.ts"
      ),
      requiredExports: REQUIRED_RUNTIME_CLOUDFLARE_EXPORTS,
      surface: "cloudflare",
    }),
    ...findRuntimeDeclarationExportLeaks({
      cwd,
      file: join(
        packageDistPath(cwd, "runtime"),
        "platform",
        "file",
        "index.d.ts"
      ),
      requiredExports: REQUIRED_RUNTIME_FILE_EXPORTS,
      surface: "file",
    }),
    ...findRuntimeDeclarationExportLeaks({
      cwd,
      file: join(packageDistPath(cwd, "runtime"), "otel", "index.d.ts"),
      requiredExports: REQUIRED_RUNTIME_OTEL_EXPORTS,
      surface: "otel",
    }),
    ...findRuntimePublicPatternLeaks({ cwd }),
  ];
}

function findRuntimePublicPatternLeaks({ cwd }) {
  const errors = [];
  const distPath = packageDistPath(cwd, "runtime");
  const files = listFiles(distPath, (file) =>
    RUNTIME_PUBLIC_ARTIFACT_RE.test(file)
  );

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const { description, pattern } of FORBIDDEN_RUNTIME_PUBLIC_PATTERNS) {
      if (pattern.test(text)) {
        errors.push(`${relativeToCwd(cwd, file)}: exposes ${description}`);
      }
    }
    for (const name of FORBIDDEN_RUNTIME_SUBAGENT_NAMES) {
      if (text.includes(name)) {
        errors.push(
          `${relativeToCwd(cwd, file)}: exposes runtime-owned subagent name ${name}`
        );
      }
    }
    if (file.endsWith(`${join("runtime", "dist", "llm.d.ts")}`)) {
      for (const name of FORBIDDEN_RUNTIME_MODEL_ADAPTER_NAMES) {
        if (text.includes(name)) {
          errors.push(
            `${relativeToCwd(cwd, file)}: exposes removed runtime LLM adapter name ${name}`
          );
        }
      }
    }
  }

  return errors;
}

function findRuntimeDeclarationExportLeaks({
  cwd,
  file,
  requiredExports,
  surface,
}) {
  if (!existsSync(file)) {
    return [
      `${relativeToCwd(cwd, file)}: missing ${surface} runtime declaration`,
    ];
  }

  const text = readFileSync(file, "utf8");
  const errors = [];

  if (surface === "root") {
    for (const name of FORBIDDEN_RUNTIME_ROOT_NAMES) {
      if (hasDeclarationToken(text, name)) {
        errors.push(
          `${relativeToCwd(cwd, file)}: root declaration exposes internal runtime name ${name}`
        );
      }
    }
  }

  for (const name of requiredExports) {
    if (!hasDeclarationToken(text, name)) {
      errors.push(
        `${relativeToCwd(cwd, file)}: missing explicit ${surface} runtime export ${name}`
      );
    }
  }
  return errors;
}

function hasDeclarationToken(text, token) {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`).test(text);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
