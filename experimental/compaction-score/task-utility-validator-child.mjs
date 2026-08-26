import { writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";

const PROVISIONAL_EVENT_COUNT_PATTERN = /\beventCount\b/;
const arrayIsArray = Array.isArray;
const hasOwn = Object.hasOwn;
const jsonParse = JSON.parse;
const jsonStringify = JSON.stringify;
const reflectApply = Reflect.apply;
const reflectGet = Reflect.get;
const testProvisionalEventCount = RegExp.prototype.test.bind(
  PROVISIONAL_EVENT_COUNT_PATTERN
);
const protocolNonce = crypto.randomUUID();
const protocolStringify = JSON.stringify;
const protocolWrite = writeFileSync;
const [fixtureId, workspaceArgument, targetFile] = process.argv.slice(2);
writeProtocol({ kind: "challenge", nonce: protocolNonce });

if (fixtureId && workspaceArgument && targetFile) {
  try {
    const workspace = resolve(workspaceArgument);
    const entries = (await readdir(workspace)).filter(
      (entry) => entry !== "task-utility-receipt.json"
    );
    const source = await readFile(join(workspace, targetFile), "utf8");
    const moduleUrl = pathToFileURL(join(workspace, targetFile));
    moduleUrl.searchParams.set("validation", crypto.randomUUID());
    const keepAlive = new MessageChannel();
    keepAlive.port1.on("message", () => undefined);
    const module = await import(moduleUrl.href).finally(() => {
      keepAlive.port1.close();
      keepAlive.port2.close();
    });
    const checks = [
      {
        id: "scope",
        passed: entries.length === 1 && entries[0] === targetFile,
      },
      ...behaviorChecks(fixtureId, module, source),
    ];
    writeProtocol({
      kind: "result",
      nonce: protocolNonce,
      validation: { checks, passed: checks.every((check) => check.passed) },
    });
  } catch {
    writeProtocol({ kind: "error", nonce: protocolNonce });
    process.exitCode = 1;
  }
} else {
  writeProtocol({ kind: "error", nonce: protocolNonce });
  process.exitCode = 1;
}

function behaviorChecks(fixtureId, module, source) {
  switch (fixtureId) {
    case "exec-committed-event-telemetry": {
      const buildExecResult = functionExport(module, "buildExecResult");
      const result = asRecord(buildExecResult(["one", "two"]));
      return [
        {
          id: "committed-count",
          passed: reflectGet(result, "committedEventCount") === 2,
        },
        { id: "no-provisional-name", passed: !hasOwn(result, "eventCount") },
        {
          id: "metadata-schema",
          passed: reflectGet(result, "metadataSchema") === "pss-headless-v1",
        },
        {
          id: "serialized-count",
          passed:
            reflectGet(
              asRecord(jsonParse(jsonStringify(result))),
              "committedEventCount"
            ) === 2,
        },
        {
          id: "source-no-eventCount",
          passed: !testProvisionalEventCount(source),
        },
      ];
    }
    case "prompt-template-dollar-escape": {
      const expand = functionExport(module, "expandPromptTemplate");
      return [
        {
          id: "combined-expansion",
          passed:
            expand("Price $$5; owner $1; all $ARGUMENTS", ["Ada"]) ===
            "Price $5; owner Ada; all Ada",
        },
        {
          id: "literal-arguments",
          passed: expand("Keep $$ARGUMENTS", ["secret"]) === "Keep $ARGUMENTS",
        },
        {
          id: "no-rescan",
          passed: expand("Fix $1", ["$$ARGUMENTS"]) === "Fix $$ARGUMENTS",
        },
        { id: "zero-literal", passed: expand("Keep $0", []) === "Keep $0" },
      ];
    }
    case "workspace-cache-ignore-correction": {
      const ignored = functionExport(module, "isIgnoredWorkspacePath");
      return [
        { id: "root-cache", passed: ignored(".cache/index.json") === true },
        {
          id: "nested-cache",
          passed: ignored("packages/a/.cache/index.json") === true,
        },
        {
          id: "substring-not-segment",
          passed: ignored("src/my.cache/file.ts") === false,
        },
        {
          id: "pnpm-store-not-ignored",
          passed: ignored(".pnpm-store/index.json") === false,
        },
        {
          id: "build-not-ignored",
          passed: ignored("packages/a/build/index.js") === false,
        },
        {
          id: "preserve-dist",
          passed: ignored("packages/a/dist/index.js") === true,
        },
      ];
    }
    default:
      throw new TypeError(`Unknown task utility fixture: ${fixtureId}`);
  }
}

function functionExport(module, name) {
  const value = reflectGet(module, name);
  if (typeof value !== "function") {
    throw new TypeError(`Missing function export: ${name}`);
  }
  return (...args) => reflectApply(value, undefined, args);
}

function asRecord(value) {
  if (typeof value !== "object" || value === null || arrayIsArray(value)) {
    throw new TypeError("Expected task fixture to return an object.");
  }
  return value;
}

function writeProtocol(value) {
  protocolWrite(3, `${protocolStringify(value)}\n`);
}
