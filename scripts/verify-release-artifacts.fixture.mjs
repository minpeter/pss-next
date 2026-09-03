import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runtimeCloudflareWorkerDeclaration as cloudflareWorkerDeclaration,
  runtimeRootDeclaration as rootDeclaration,
  runtimeChannelDeclaration,
  runtimeCloudflareDeclaration,
  runtimeDurableObjectDeclaration,
  runtimeExecutionDeclaration,
  runtimeFileDeclaration,
  runtimeMemoryDeclaration,
  runtimeOtelDeclaration,
} from "./verify-release-artifacts-runtime-fixtures.mjs";

export const cliBinReadFailurePattern =
  /^apps\/coding-agent\/bin\/pss\.js: cannot read CLI bin target /;
export const forbiddenModelName = ["Agent", "Model"].join("");
export const runtimeRootDeclaration = rootDeclaration;
export const runtimeCloudflareWorkerDeclaration = cloudflareWorkerDeclaration;

let tempRoots = [];

export function createTrackedTempRoot(prefix) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(cwd);
  return cwd;
}

export function createFixture() {
  const cwd = createTrackedTempRoot("pss-release-artifacts-");

  for (const packageName of [
    "runtime",
    "extension-latex",
    "extension-mermaid",
    "extension-web",
    "coding-agent",
  ]) {
    const packageRoot = fixturePackageRoot(cwd, packageName);
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      join(packageRoot, "dist", "index.js"),
      "export const ok = true;\n"
    );
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify(packageMetadata(packageName), null, 2)
    );
    writePackageDeclarationFixtures(cwd, packageName, packageRoot);
  }

  return cwd;
}

export function cleanupFixtures() {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots = [];
}

function packageMetadata(packageName) {
  if (packageName === "runtime") {
    return { bin: { "pss-eval": "./bin/pss-eval.js" } };
  }
  if (packageName === "coding-agent") {
    return {
      bin: {
        pss: "./bin/pss.js",
        "pss-coding-agent": "./bin/pss.js",
      },
    };
  }
  return {
    exports: {
      ".": {
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
    },
    files: ["dist", "README.md"],
    name: `@minpeter/pss-${packageName}`,
  };
}

function fixturePackageRoot(cwd, packageName) {
  if (packageName === "coding-agent") {
    return join(cwd, "apps", "coding-agent");
  }
  if (packageName.startsWith("extension-")) {
    return join(cwd, "extensions", packageName.slice("extension-".length));
  }
  return join(cwd, "packages", packageName);
}

function writePackageDeclarationFixtures(cwd, packageName, packageRoot) {
  const declaration =
    packageName === "runtime"
      ? runtimeRootDeclaration
      : "export declare const ok: true;\n";
  writeFileSync(join(packageRoot, "dist", "index.d.ts"), declaration);

  if (packageName === "runtime") {
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    writeFileSync(
      join(packageRoot, "bin", "pss-eval.js"),
      "#!/usr/bin/env node\nimport '../dist/evals/cli.js';\n",
      { mode: 0o755 }
    );
    writeRuntimeDeclarationFixtures(cwd, packageName);
    return;
  }
  if (packageName === "extension-latex") {
    writeFileSync(
      join(packageRoot, "dist", "mathjax-worker.js"),
      "export const ok = true;\n"
    );
    return;
  }
  if (packageName === "extension-mermaid") {
    writeFileSync(
      join(packageRoot, "dist", "mermaid-art-worker.js"),
      "export const ok = true;\n"
    );
    return;
  }
  if (packageName !== "coding-agent") {
    return;
  }

  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(
    join(packageRoot, "bin", "pss.js"),
    "#!/usr/bin/env node\nimport '../dist/tui.js';\n",
    { mode: 0o755 }
  );
  writeFileSync(
    join(packageRoot, "dist", "tui.js"),
    "export const ok = true;\n"
  );
  for (const worker of [
    join("extensions", "latex", "dist", "mathjax-worker.js"),
    join("extensions", "mermaid", "dist", "mermaid-art-worker.js"),
  ]) {
    const workerPath = join(packageRoot, "dist", worker);
    mkdirSync(dirname(workerPath), { recursive: true });
    writeFileSync(workerPath, "export const ok = true;\n");
  }
}

function writeRuntimeDeclarationFixtures(cwd, packageName) {
  mkdirSync(join(cwd, "packages", packageName, "dist", "channel"), {
    recursive: true,
  });
  writeFileSync(
    join(cwd, "packages", packageName, "dist", "channel", "index.d.ts"),
    runtimeChannelDeclaration
  );
  mkdirSync(join(cwd, "packages", packageName, "dist", "execution"), {
    recursive: true,
  });
  writeFileSync(
    join(cwd, "packages", packageName, "dist", "execution", "index.d.ts"),
    runtimeExecutionDeclaration
  );
  mkdirSync(join(cwd, "packages", packageName, "dist", "platform", "memory"), {
    recursive: true,
  });
  writeFileSync(
    join(
      cwd,
      "packages",
      packageName,
      "dist",
      "platform",
      "memory",
      "index.d.ts"
    ),
    runtimeMemoryDeclaration
  );
  mkdirSync(
    join(
      cwd,
      "packages",
      packageName,
      "dist",
      "platform",
      "durable-object",
      "host"
    ),
    { recursive: true }
  );
  writeFileSync(
    join(
      cwd,
      "packages",
      packageName,
      "dist",
      "platform",
      "durable-object",
      "host",
      "storage-host.d.ts"
    ),
    runtimeDurableObjectDeclaration
  );
  mkdirSync(
    join(
      cwd,
      "packages",
      packageName,
      "dist",
      "platform",
      "durable-object",
      "cloudflare",
      "agents"
    ),
    { recursive: true }
  );
  writeFileSync(
    join(
      cwd,
      "packages",
      packageName,
      "dist",
      "platform",
      "durable-object",
      "cloudflare",
      "agents",
      "index.d.ts"
    ),
    runtimeCloudflareDeclaration
  );
  mkdirSync(join(cwd, "packages", packageName, "dist", "platform", "file"), {
    recursive: true,
  });
  writeFileSync(
    join(
      cwd,
      "packages",
      packageName,
      "dist",
      "platform",
      "file",
      "index.d.ts"
    ),
    runtimeFileDeclaration
  );
  mkdirSync(join(cwd, "packages", packageName, "dist", "otel"), {
    recursive: true,
  });
  writeFileSync(
    join(cwd, "packages", packageName, "dist", "otel", "index.d.ts"),
    runtimeOtelDeclaration
  );
  writeFileSync(
    join(cwd, "packages", packageName, "dist", "llm.d.ts"),
    "export declare const ok: true;\n"
  );
}
