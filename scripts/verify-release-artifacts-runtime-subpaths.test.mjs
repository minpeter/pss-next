import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseArtifacts } from "./verify-release-artifacts/core.mjs";
import {
  REQUIRED_RUNTIME_CHANNEL_EXPORTS,
  REQUIRED_RUNTIME_CLOUDFLARE_AGENTS_EXPORTS,
  REQUIRED_RUNTIME_CLOUDFLARE_WORKER_EXPORTS,
  REQUIRED_RUNTIME_DURABLE_OBJECT_EXPORTS,
  REQUIRED_RUNTIME_EXECUTION_EXPORTS,
  REQUIRED_RUNTIME_OTEL_EXPORTS,
} from "./verify-release-artifacts/runtime-public-surface.mjs";
import {
  cleanupFixtures,
  createFixture,
  runtimeCloudflareWorkerDeclaration,
} from "./verify-release-artifacts.fixture.mjs";

afterEach(cleanupFixtures);

function runtimeDistDeclaration(cwd, ...segments) {
  return join(cwd, "packages", "runtime", "dist", ...segments, "index.d.ts");
}

function runtimeDistFile(cwd, ...segments) {
  return join(cwd, "packages", "runtime", "dist", ...segments);
}

describe("verifyReleaseArtifacts runtime subpath checks", () => {
  it("requires the runtime channel declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(runtimeDistDeclaration(cwd, "channel"));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/channel/index.d.ts: missing channel runtime declaration",
    ]);
  });

  it("checks the channel contract on its declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(runtimeDistDeclaration(cwd, "channel"), "export {};\n");

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual(
      REQUIRED_RUNTIME_CHANNEL_EXPORTS.map(
        (name) =>
          `packages/runtime/dist/channel/index.d.ts: missing explicit channel runtime export ${name}`
      )
    );
  });

  it("requires the runtime execution declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(join(cwd, "packages", "runtime", "dist", "execution", "index.d.ts"));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/execution/index.d.ts: missing execution runtime declaration",
    ]);
  });

  it("requires the runtime otel declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(runtimeDistDeclaration(cwd, "otel"));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/otel/index.d.ts: missing otel runtime declaration",
    ]);
  });

  it("checks the OpenTelemetry adapter declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(runtimeDistDeclaration(cwd, "otel"), "export {};\n");

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual(
      REQUIRED_RUNTIME_OTEL_EXPORTS.map(
        (name) =>
          `packages/runtime/dist/otel/index.d.ts: missing explicit otel runtime export ${name}`
      )
    );
  });

  it("requires the runtime durable object declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(
      runtimeDistFile(
        cwd,
        "platform",
        "durable-object",
        "host",
        "storage-host.d.ts"
      )
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/durable-object/host/storage-host.d.ts: missing durable object runtime declaration",
    ]);
  });

  it("checks durable object helpers on the durable object declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      runtimeDistFile(
        cwd,
        "platform",
        "durable-object",
        "host",
        "storage-host.d.ts"
      ),
      "export {};\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual(
      REQUIRED_RUNTIME_DURABLE_OBJECT_EXPORTS.map(
        (name) =>
          `packages/runtime/dist/platform/durable-object/host/storage-host.d.ts: missing explicit durable object runtime export ${name}`
      )
    );
  });

  it("requires the runtime cloudflare declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(
      runtimeDistDeclaration(
        cwd,
        "platform",
        "durable-object",
        "cloudflare",
        "agents"
      )
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/durable-object/cloudflare/agents/index.d.ts: missing cloudflare runtime declaration",
    ]);
  });

  it("requires the runtime memory declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(runtimeDistDeclaration(cwd, "platform", "memory"));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/memory/index.d.ts: missing memory runtime declaration",
    ]);
  });

  it("checks Cloudflare Worker helpers on the cloudflare declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      runtimeDistDeclaration(
        cwd,
        "platform",
        "durable-object",
        "cloudflare",
        "agents"
      ),
      "export {};\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      ...REQUIRED_RUNTIME_CLOUDFLARE_WORKER_EXPORTS.map(
        (name) =>
          `packages/runtime/dist/platform/durable-object/cloudflare/agents/index.d.ts: missing explicit cloudflare runtime export ${name}`
      ),
      ...REQUIRED_RUNTIME_CLOUDFLARE_AGENTS_EXPORTS.map(
        (name) =>
          `packages/runtime/dist/platform/durable-object/cloudflare/agents/index.d.ts: missing explicit cloudflare runtime export ${name}`
      ),
    ]);
  });

  it("checks Cloudflare Agents helpers on the canonical cloudflare declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      runtimeDistDeclaration(
        cwd,
        "platform",
        "durable-object",
        "cloudflare",
        "agents"
      ),
      runtimeCloudflareWorkerDeclaration
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual(
      REQUIRED_RUNTIME_CLOUDFLARE_AGENTS_EXPORTS.map(
        (name) =>
          `packages/runtime/dist/platform/durable-object/cloudflare/agents/index.d.ts: missing explicit cloudflare runtime export ${name}`
      )
    );
  });

  it("checks advanced runtime contracts on the execution declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "execution", "index.d.ts"),
      "export {};\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual(
      REQUIRED_RUNTIME_EXECUTION_EXPORTS.map(
        (name) =>
          `packages/runtime/dist/execution/index.d.ts: missing explicit execution runtime export ${name}`
      )
    );
  });

  it("reports required exports whose names are substrings of present exports", () => {
    const cwd = createFixture();
    writeFileSync(
      runtimeDistDeclaration(cwd, "platform", "memory"),
      'export { createInMemoryHost } from "./index";\n'
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export InMemoryHost",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export InMemoryExecutionScheduler",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryScheduledThreadPrompt",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryScheduledWorkListOptions",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryThreadStore",
    ]);
  });

  it("checks memory helpers on the memory declaration subpath", () => {
    const cwd = createFixture();
    writeFileSync(
      runtimeDistDeclaration(cwd, "platform", "memory"),
      "export {};\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export createInMemoryHost",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export InMemoryHost",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export InMemoryExecutionScheduler",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryScheduledThreadPrompt",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryScheduledWorkListOptions",
      "packages/runtime/dist/platform/memory/index.d.ts: missing explicit memory runtime export MemoryThreadStore",
    ]);
  });
});
