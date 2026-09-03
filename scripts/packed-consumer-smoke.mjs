#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_SCOPE_PREFIX = /^@/u;
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "pss-packed-consumer-"));

try {
  await writeFile(
    join(temporary, "package.json"),
    `${JSON.stringify({ name: "pss-packed-consumer", private: true })}\n`,
    "utf8"
  );
  const tarballs = [
    pack("packages/runtime"),
    pack("apps/coding-agent"),
    pack("extensions/latex"),
    pack("extensions/mermaid"),
    pack("extensions/web"),
  ];
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      ...tarballs,
    ],
    temporary
  );

  await writeFile(
    join(temporary, "consumer.mjs"),
    `import { createAgent } from "@minpeter/pss-runtime";
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";
import { createCodingAgent, createCodingAgentTools } from "@minpeter/pss-coding-agent";
import { resolveStartTuiTools } from "@minpeter/pss-coding-agent/tools";
import { createWorkspaceTools } from "@minpeter/pss-coding-agent/workspace-tools";
import createLatexExtension from "@minpeter/pss-extension-latex";
import createMermaidExtension from "@minpeter/pss-extension-mermaid";
import createWebExtension from "@minpeter/pss-extension-web";

for (const [name, value] of Object.entries({
  createAgent,
  createCodingAgent,
  createCodingAgentTools,
  createInMemoryHost,
  createLatexExtension,
  createMermaidExtension,
  createWebExtension,
  createWorkspaceTools,
  resolveStartTuiTools,
})) {
  if (typeof value !== "function") throw new TypeError(name + " is not callable");
}
`,
    "utf8"
  );

  run(process.execPath, ["consumer.mjs"], temporary);
  run(
    process.execPath,
    [
      join(temporary, "node_modules/@minpeter/pss-runtime/bin/pss-eval.js"),
      "--help",
    ],
    temporary
  );
  run(
    process.execPath,
    [
      join(temporary, "node_modules/@minpeter/pss-coding-agent/bin/pss.js"),
      "--help",
    ],
    temporary
  );
  console.log("Packed-tarball consumer smoke passed");
} finally {
  await rm(temporary, { force: true, recursive: true });
}

function pack(packageDirectory) {
  const destination = temporary;
  run(
    "pnpm",
    ["pack", "--pack-destination", destination],
    resolve(root, packageDirectory)
  );
  const packageJson = JSON.parse(
    readFileSync(resolve(root, packageDirectory, "package.json"), "utf8")
  );
  const fileName = `${packageJson.name.replace(PACKAGE_SCOPE_PREFIX, "").replaceAll("/", "-")}-${packageJson.version}.tgz`;
  return join(destination, fileName);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout}${result.stderr}`
    );
  }
}
