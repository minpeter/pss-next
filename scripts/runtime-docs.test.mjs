import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("runtime docs", () => {
  it("keeps the root quick start on the public factory and thread APIs", () => {
    const readme = readRepoFile("README.md");

    expect(readme).toContain(
      'import { createAgent } from "@minpeter/pss-runtime"'
    );
    expect(readme).toContain("const agent = await createAgent({");
    expect(readme).toContain('const thread = agent.thread("default")');
    expect(readme).not.toContain(
      'import { Agent } from "@minpeter/pss-runtime"'
    );
    expect(readme).not.toContain("new Agent({");
    expect(readme).not.toContain("agent.session(");
    expect(readme).not.toContain("~/.pss/sessions");
  });

  it("documents thread storage env vars next to the CLI", () => {
    const readme = readRepoFile("apps/coding-agent/README.md");

    expect(readme).toContain("PSS_THREAD_DIR");
    expect(readme).toContain("PSS_THREAD_KEY");
    expect(readme).not.toContain("~/.pss/sessions");
  });

  it("keeps raw turn.events as the public control loop", () => {
    const readme = readRepoFile("packages/runtime/README.md");
    const changelog = readRepoFile("packages/runtime/CHANGELOG.md");
    const turnSource = readRepoFile(
      "packages/runtime/src/thread/protocol/turn.ts"
    );

    expect(readme).toContain("for await (const event of turn.events())");
    expect(readme).toContain("thread.steer");
    expect(readme).not.toContain("consumeRunEvents");
    expect(changelog).toContain("## 0.1.0");
    expect(changelog).not.toContain("consumeRunEvents");
    expect(turnSource).not.toContain("consumeRunEvents");
    expect(turnSource).not.toContain("AgentRunEventListener");
  });

  it("documents the single AgentHost factory surface", () => {
    const readme = readRepoFile("packages/runtime/README.md");

    expect(readme).toContain("createInMemoryHost");
    expect(readme).toContain("createFileHost");
    expect(readme).toContain("const host: AgentHost = createInMemoryHost()");
    expect(readme).not.toContain("DurableBackgroundHost");
    expect(readme).not.toContain("createNodeFileThreadHost");
    expect(readme).not.toContain("createInMemoryExecutionHost");
  });
});
