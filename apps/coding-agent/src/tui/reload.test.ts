import { describe, expect, it } from "vitest";
import type { LoadedConfiguredExtensions } from "../extensions";
import type { TuiCommand } from "./command";
import {
  buildReloadedExtensionRuntime,
  disposePreviousExtensionRuntime,
} from "./reload";

interface FakeAgent {
  dispose(): Promise<void>;
  readonly disposed: boolean[];
}

interface FakeHost {
  dispose(): Promise<void>;
  readonly disposed: boolean[];
}

function fakeAgent(): FakeAgent {
  const disposed: boolean[] = [];
  return {
    dispose: () => {
      disposed.push(true);
      return Promise.resolve();
    },
    disposed,
  };
}

function fakeHost(): FakeHost {
  const disposed: boolean[] = [];
  return {
    dispose: () => {
      disposed.push(true);
      return Promise.resolve();
    },
    disposed,
  };
}

const loaded: LoadedConfiguredExtensions = {
  extensions: [],
  notices: ["notice-a"],
};

const command: TuiCommand = {
  description: "noop",
  execute: () => ({ success: true }),
  name: "noop",
};

describe("buildReloadedExtensionRuntime", () => {
  it("builds and activates the replacement runtime before returning", async () => {
    // Given
    const host = fakeHost();
    const agent = fakeAgent();
    const order: string[] = [];

    // When
    const swap = await buildReloadedExtensionRuntime<FakeAgent, FakeHost>({
      activateHost: (_host, _agent) => {
        order.push("activate");
        return Promise.resolve();
      },
      createAgent: () => {
        order.push("agent");
        return Promise.resolve(agent);
      },
      createHost: () => {
        order.push("host");
        return Promise.resolve(host);
      },
      loadExtensions: () => {
        order.push("load");
        return Promise.resolve(loaded);
      },
      mergeCommands: () => {
        order.push("commands");
        return [command];
      },
      mergeToolRenderers: () => {
        order.push("renderers");
        return {};
      },
    });

    // Then
    expect(order).toEqual([
      "load",
      "host",
      "commands",
      "renderers",
      "agent",
      "activate",
    ]);
    expect(swap.agent).toBe(agent);
    expect(swap.host).toBe(host);
    expect(swap.commands).toEqual([command]);
    expect(swap.notices).toEqual(["notice-a"]);
    expect(host.disposed).toEqual([]);
    expect(agent.disposed).toEqual([]);
  });

  it("disposes partial resources and rethrows when activation fails", async () => {
    // Given
    const host = fakeHost();
    const agent = fakeAgent();

    // When / Then
    await expect(
      buildReloadedExtensionRuntime<FakeAgent, FakeHost>({
        activateHost: () => Promise.reject(new Error("activation exploded")),
        createAgent: () => Promise.resolve(agent),
        createHost: () => Promise.resolve(host),
        loadExtensions: () => Promise.resolve(loaded),
        mergeCommands: () => [command],
        mergeToolRenderers: () => ({}),
      })
    ).rejects.toThrow("activation exploded");
    expect(agent.disposed).toEqual([true]);
    expect(host.disposed).toEqual([true]);
  });

  it("aborts before creating the agent when command merging fails", async () => {
    // Given
    const host = fakeHost();
    let agentCreated = false;

    // When / Then
    await expect(
      buildReloadedExtensionRuntime<FakeAgent, FakeHost>({
        activateHost: () => Promise.resolve(),
        createAgent: () => {
          agentCreated = true;
          return Promise.resolve(fakeAgent());
        },
        createHost: () => Promise.resolve(host),
        loadExtensions: () => Promise.resolve(loaded),
        mergeCommands: () => {
          throw new Error("command conflict");
        },
        mergeToolRenderers: () => ({}),
      })
    ).rejects.toThrow("command conflict");
    expect(agentCreated).toBe(false);
    expect(host.disposed).toEqual([true]);
  });

  it("keeps nothing when extension loading fails", async () => {
    // Given
    let hostCreated = false;

    // When / Then
    await expect(
      buildReloadedExtensionRuntime<FakeAgent, FakeHost>({
        activateHost: () => Promise.resolve(),
        createAgent: () => Promise.resolve(fakeAgent()),
        createHost: () => {
          hostCreated = true;
          return Promise.resolve(fakeHost());
        },
        loadExtensions: () => Promise.reject(new Error("discovery failed")),
        mergeCommands: () => [command],
        mergeToolRenderers: () => ({}),
      })
    ).rejects.toThrow("discovery failed");
    expect(hostCreated).toBe(false);
  });
});

describe("disposePreviousExtensionRuntime", () => {
  it("disposes everything and reports failures as notices", async () => {
    // Given
    const agent = fakeAgent();
    const host = fakeHost();

    // When
    const clean = await disposePreviousExtensionRuntime({
      agent,
      disposeThread: () => Promise.resolve(),
      host,
    });
    const failing = await disposePreviousExtensionRuntime({
      agent: {
        dispose: () => Promise.reject(new Error("agent stuck")),
      },
      disposeThread: () => Promise.reject(new Error("thread stuck")),
      host: fakeHost(),
    });

    // Then
    expect(clean).toEqual([]);
    expect(agent.disposed).toEqual([true]);
    expect(host.disposed).toEqual([true]);
    expect(failing).toHaveLength(2);
    expect(failing[0]).toContain("thread stuck");
    expect(failing[1]).toContain("agent stuck");
  });
});
