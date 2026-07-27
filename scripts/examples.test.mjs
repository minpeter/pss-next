import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appPackages, examplePackages } from "./examples.fixture.mjs";

const finalRunEventsLoopPattern =
  /for await \(const event of run\.events\(\)\) \{\s+console\.log\(event\);\s+\}$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function expectSourceToOmit(path, forbiddenNames) {
  const source = readText(path);

  for (const forbiddenName of forbiddenNames) {
    expect(source).not.toContain(forbiddenName);
  }
}

describe("examples workspace packages", () => {
  it("exposes examples as independent package.json workspaces", () => {
    const rootPackageJson = readJson("package.json");
    const workspace = readText("pnpm-workspace.yaml");

    expect(workspace).toContain('- "examples/*"');

    for (const examplePackage of examplePackages) {
      const packageJsonPath = join(examplePackage.path, "package.json");
      const sourcePath = join(
        examplePackage.path,
        examplePackage.requiredSource
      );
      const packageJson = readJson(packageJsonPath);
      const startScript =
        examplePackage.startScript ??
        "tsx --conditions=@minpeter/pss-source src/index.ts";

      expect(packageJson.private).toBe(true);
      expect(packageJson.name).toBe(examplePackage.name);
      expect(packageJson.scripts.start).toBe(startScript);
      expect(packageJson.dependencies["@minpeter/pss-runtime"]).toBe(
        "workspace:*"
      );
      expect(packageJson.dependencies["@ai-sdk/openai-compatible"]).toBe(
        rootPackageJson.devDependencies["@ai-sdk/openai-compatible"]
      );
      expect(packageJson.dependencies["@t3-oss/env-core"]).toBe("^0.13.11");
      expect(packageJson.dependencies.dotenv).toBe("^17.4.2");
      expect(packageJson.dependencies.zod).toBe("^4.4.3");
      expect(packageJson.dependencies).not.toHaveProperty(
        "@minpeter/pss-coding-agent"
      );
      expect(existsSync(sourcePath)).toBe(true);
    }
  });

  it("exposes apps as independent workspace packages", () => {
    const workspace = readText("pnpm-workspace.yaml");
    const rootPackageJson = readJson("package.json");
    const rootTsconfig = readJson("tsconfig.json");

    expect(workspace).toContain('- "apps/*"');
    expect(rootPackageJson.workspaces).toContain("apps/*");
    expect(rootPackageJson.scripts["dev:tui"]).toBe(
      "tsx --conditions=@minpeter/pss-source apps/coding-agent/src/tui/app.ts"
    );
    expect(rootTsconfig.include).toContain("apps/*/src/**/*.ts");

    for (const appPackage of appPackages) {
      const packageJsonPath = join(appPackage.path, "package.json");
      const sourcePath = join(appPackage.path, appPackage.requiredSource);
      const packageJson = readJson(packageJsonPath);

      expect(packageJson.name).toBe(appPackage.name);
      expect(packageJson.scripts.build).toBe(appPackage.buildScript);
      expect(packageJson.dependencies["@minpeter/pss-runtime"]).toBe(
        "workspace:^"
      );
      expect(packageJson.dependencies).not.toHaveProperty(
        "@minpeter/pss-coding-agent"
      );
      expect(existsSync(sourcePath)).toBe(true);
    }
  });

  it("keeps root dev pointed at the basic example package", () => {
    const rootPackageJson = readJson("package.json");

    expect(rootPackageJson.scripts.dev).toBe(
      "pnpm --filter @minpeter/pss-example-basic start"
    );
  });

  it("includes hooks and basic runtime API usage examples", () => {
    const basicSetupSource = readText("examples/basic/src/setup.ts");
    const basicIndexSource = readText("examples/basic/src/index.ts");
    const hooksSource = readText("examples/hooks/src/index.ts");

    for (const source of [basicSetupSource, hooksSource]) {
      expect(source).toContain("createOpenAICompatible");
      expect(source).toContain('loadEnv({ path: ".env"');
      expect(source).not.toContain("RuntimeLlm");
      expect(source).not.toContain("@minpeter/pss-coding-agent");
    }

    expect(basicSetupSource).toContain('thread("default")');
    expect(basicIndexSource).toContain("readline");
    expect(basicIndexSource).toContain("thread.send");
    expect(basicIndexSource).toContain("/quit");
    expect(basicIndexSource).toContain("drain(");

    expect(hooksSource).toContain(".send(");
    expect(hooksSource.trim()).toMatch(finalRunEventsLoopPattern);
    expect(hooksSource).toContain("hooks:");
    expect(hooksSource).toContain("AgentHooks");
    expect(hooksSource).toContain("acceptInput(");
    expect(hooksSource).toContain("event.type");
    expect(hooksSource).not.toContain("process.argv");
  });

  it("keeps the sync-subagent example focused on conversation hooks and file reads", () => {
    const packageJson = readJson("examples/sync-subagent/package.json");
    const indexSource = readText("examples/sync-subagent/src/index.ts");
    const setupSource = readText("examples/sync-subagent/src/setup.ts");
    const agentsSource = readText("examples/sync-subagent/src/agents.ts");
    const conversationHooksSource = readText(
      "examples/sync-subagent/src/conversation-hooks.ts"
    );
    const delegateToolSource = readText(
      "examples/sync-subagent/src/delegate-tool.ts"
    );
    const readFileToolSource = readText(
      "examples/sync-subagent/src/read-file-tool.ts"
    );

    expect(packageJson.scripts.start).toBe(
      "tsx --conditions=@minpeter/pss-source src/index.ts"
    );
    expect(packageJson.scripts).not.toHaveProperty("start:background");
    expect(packageJson.scripts).not.toHaveProperty("start:background:wait");

    expect(setupSource).toContain("createExampleRuntime");
    expect(setupSource).toContain("createOpenAICompatible");
    expect(indexSource).toContain("readline");
    expect(indexSource).toContain("thread.send");
    expect(indexSource).toContain("/quit");
    expect(indexSource).toContain("kb/");

    expect(agentsSource).toContain('namespace: "reader"');
    expect(agentsSource).toContain("hooks:");
    expect(agentsSource).toContain("createConversationHooks");
    expect(agentsSource).toContain("createDelegateToReaderTool");
    expect(agentsSource).toContain("read_file: createReadFileTool()");

    expect(conversationHooksSource).toContain('action: "transform"');
    expect(conversationHooksSource).toContain("user-input");

    expect(delegateToolSource).toContain("delegate_to_reader");
    expect(delegateToolSource).toContain("delegateUserInput");
    expect(delegateToolSource).not.toContain('mode: "background"');
    for (const sourcePath of [
      "examples/sync-subagent/src/agents.ts",
      "examples/sync-subagent/src/delegate-tool.ts",
      "examples/sync-subagent/src/index.ts",
      "examples/sync-subagent/src/setup.ts",
    ]) {
      expectSourceToOmit(sourcePath, [
        "subagents:",
        "resumeBackgroundChildRun",
        "backgroundSubagents",
        "background-subagent",
        "subagent-job-",
      ]);
    }

    expect(readFileToolSource).toContain("readFile");
    expect(readFileToolSource).toContain("fixtures");
    expect(readFileToolSource).toContain("kb");
    expect(existsSync("examples/sync-subagent/fixtures/kb/pricing.md")).toBe(
      true
    );
    expect(existsSync("examples/sync-subagent/fixtures/kb/faq.md")).toBe(true);
    expect(existsSync("examples/sync-subagent/src/background.ts")).toBe(false);
    expect(existsSync("examples/sync-subagent/src/delegation.ts")).toBe(false);
  });

  it("keeps the background-subagent example focused on durable background delegation", () => {
    const packageJson = readJson("examples/background-subagent/package.json");
    const indexSource = readText("examples/background-subagent/src/index.ts");
    const agentsSource = readText("examples/background-subagent/src/agents.ts");
    const delegateToolSource = readText(
      "examples/background-subagent/src/delegate-tool.ts"
    );
    const backgroundDelegationSource = readText(
      "examples/background-subagent/src/background-delegation.ts"
    );

    expect(packageJson.scripts.start).toBe(
      "tsx --conditions=@minpeter/pss-source src/index.ts"
    );
    expect(packageJson.scripts).not.toHaveProperty("start:cli");
    const setupSource = readText("examples/background-subagent/src/setup.ts");

    expect(setupSource).toContain("createExampleRuntime");
    expect(setupSource).toContain("localHost");
    expect(indexSource).toContain("readline");
    expect(indexSource).toContain("thread.send");
    expect(indexSource).toContain("host.resumeThread");
    expect(indexSource).toContain("/quit");
    expect(indexSource).toContain("kb/");
    expect(
      existsSync("examples/background-subagent/fixtures/kb/product.md")
    ).toBe(true);
    expect(existsSync("examples/background-subagent/src/cli.ts")).toBe(false);

    expect(agentsSource).toContain("background_output");
    expect(agentsSource).toContain("createDelegateToReaderTool");
    expect(agentsSource).toContain("createConversationHooks");

    expect(delegateToolSource).toContain("launchDurableBackgroundDelegation");
    expect(backgroundDelegationSource).toContain("task_id");
    expect(backgroundDelegationSource).toContain("<system-reminder>");

    for (const sourcePath of [
      "examples/background-subagent/src/agents.ts",
      "examples/background-subagent/src/app-agent-factory.ts",
      "examples/background-subagent/src/background-delegation.ts",
      "examples/background-subagent/src/background-output-tool.ts",
      "examples/background-subagent/src/delegate-tool.ts",
      "examples/background-subagent/src/index.ts",
      "examples/background-subagent/src/local-host.ts",
      "examples/background-subagent/src/setup.ts",
    ]) {
      expectSourceToOmit(sourcePath, [
        "subagents:",
        "resumeBackgroundChildRun",
        'run.kind === "background-subagent"',
        "backgroundSubagents",
        'kind: "background-subagent"',
        "background-subagent:",
        "subagent-job-",
      ]);
    }
    expect(existsSync("examples/background-subagent/src/app-agent.ts")).toBe(
      false
    );
  });
});
