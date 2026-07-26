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

const recoveryPattern = /could not be recovered/u;

const command: TuiCommand = {
  description: "noop",
  execute: () => ({ success: true }),
  name: "noop",
};

function baseOptions(overrides: {
  readonly activateHost?: (host: FakeHost, agent: FakeAgent) => Promise<void>;
  readonly createAgent?: () => Promise<FakeAgent>;
  readonly createHost?: () => Promise<FakeHost>;
  readonly disposePrevious?: () => Promise<readonly string[]>;
  readonly loadExtensions?: () => Promise<
    LoadedConfiguredExtensions & { rollbackModuleCache?: () => void }
  >;
  readonly mergeCommands?: () => readonly TuiCommand[];
  readonly recoverPrevious?: () => Promise<void>;
  readonly validateHost?: () => Promise<void>;
}) {
  return {
    activateHost: overrides.activateHost ?? (() => Promise.resolve()),
    createAgent: overrides.createAgent ?? (() => Promise.resolve(fakeAgent())),
    createHost: overrides.createHost ?? (() => Promise.resolve(fakeHost())),
    disposePrevious:
      overrides.disposePrevious ??
      (() => Promise.resolve([] as readonly string[])),
    loadExtensions: overrides.loadExtensions ?? (() => Promise.resolve(loaded)),
    mergeCommands: overrides.mergeCommands ?? (() => [command]),
    mergeToolRenderers: () => ({}),
    recoverPrevious: overrides.recoverPrevious ?? (() => Promise.resolve()),
    ...(overrides.validateHost === undefined
      ? {}
      : { validateHost: overrides.validateHost }),
  };
}

describe("buildReloadedExtensionRuntime", () => {
  it("disposes the previous runtime before activating the replacement", async () => {
    // Given
    const host = fakeHost();
    const agent = fakeAgent();
    const order: string[] = [];

    // When
    const swap = await buildReloadedExtensionRuntime<FakeAgent, FakeHost>(
      baseOptions({
        activateHost: () => {
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
        disposePrevious: () => {
          order.push("dispose-previous");
          return Promise.resolve(["cleanup-notice"]);
        },
        loadExtensions: () => {
          order.push("load");
          return Promise.resolve(loaded);
        },
        mergeCommands: () => {
          order.push("commands");
          return [command];
        },
        validateHost: () => {
          order.push("validate");
          return Promise.resolve();
        },
      })
    );

    // Then
    expect(order).toEqual([
      "load",
      "host",
      "commands",
      "validate",
      "agent",
      "dispose-previous",
      "activate",
    ]);
    expect(swap.agent).toBe(agent);
    expect(swap.host).toBe(host);
    expect(swap.notices).toEqual(["notice-a", "cleanup-notice"]);
    expect(host.disposed).toEqual([]);
    expect(agent.disposed).toEqual([]);
  });

  it("keeps the previous runtime when the build phase fails", async () => {
    // Given
    const host = fakeHost();
    const rollbacks: boolean[] = [];
    let previousDisposed = false;

    // When / Then
    await expect(
      buildReloadedExtensionRuntime<FakeAgent, FakeHost>(
        baseOptions({
          createHost: () => Promise.resolve(host),
          disposePrevious: () => {
            previousDisposed = true;
            return Promise.resolve([]);
          },
          loadExtensions: () =>
            Promise.resolve({
              ...loaded,
              rollbackModuleCache: () => {
                rollbacks.push(true);
              },
            }),
          validateHost: () =>
            Promise.reject(new Error("migration rejected history")),
        })
      )
    ).rejects.toThrow("migration rejected history");
    expect(previousDisposed).toBe(false);
    expect(host.disposed).toEqual([true]);
    expect(rollbacks).toEqual([true]);
  });

  it("aborts before creating the agent when command merging fails", async () => {
    // Given
    const host = fakeHost();
    let agentCreated = false;

    // When / Then
    await expect(
      buildReloadedExtensionRuntime<FakeAgent, FakeHost>(
        baseOptions({
          createAgent: () => {
            agentCreated = true;
            return Promise.resolve(fakeAgent());
          },
          createHost: () => Promise.resolve(host),
          mergeCommands: () => {
            throw new Error("command conflict");
          },
        })
      )
    ).rejects.toThrow("command conflict");
    expect(agentCreated).toBe(false);
    expect(host.disposed).toEqual([true]);
  });

  it("recovers the previous runtime when activation fails", async () => {
    // Given
    const host = fakeHost();
    const agent = fakeAgent();
    const rollbacks: boolean[] = [];
    const recoveries: boolean[] = [];

    // When / Then
    await expect(
      buildReloadedExtensionRuntime<FakeAgent, FakeHost>(
        baseOptions({
          activateHost: () => Promise.reject(new Error("activation exploded")),
          createAgent: () => Promise.resolve(agent),
          createHost: () => Promise.resolve(host),
          loadExtensions: () =>
            Promise.resolve({
              ...loaded,
              rollbackModuleCache: () => {
                rollbacks.push(true);
              },
            }),
          recoverPrevious: () => {
            recoveries.push(true);
            return Promise.resolve();
          },
        })
      )
    ).rejects.toThrow("activation exploded");
    expect(agent.disposed).toEqual([true]);
    expect(host.disposed).toEqual([true]);
    expect(rollbacks).toEqual([true]);
    expect(recoveries).toEqual([true]);
  });

  it("aggregates activation and recovery failures", async () => {
    // When / Then
    await expect(
      buildReloadedExtensionRuntime<FakeAgent, FakeHost>(
        baseOptions({
          activateHost: () => Promise.reject(new Error("activation exploded")),
          recoverPrevious: () => Promise.reject(new Error("recovery exploded")),
        })
      )
    ).rejects.toThrow(recoveryPattern);
  });

  it("keeps nothing when extension loading fails", async () => {
    // Given
    let hostCreated = false;

    // When / Then
    await expect(
      buildReloadedExtensionRuntime<FakeAgent, FakeHost>(
        baseOptions({
          createHost: () => {
            hostCreated = true;
            return Promise.resolve(fakeHost());
          },
          loadExtensions: () => Promise.reject(new Error("discovery failed")),
        })
      )
    ).rejects.toThrow("discovery failed");
    expect(hostCreated).toBe(false);
  });
});

describe("disposePreviousExtensionRuntime", () => {
  it("detaches never-settling cleanup after the timeout", async () => {
    // Given
    const hanging = new Promise<void>(() => undefined);

    // When
    const notices = await disposePreviousExtensionRuntime({
      agent: { dispose: () => hanging },
      disposeThread: () => Promise.resolve(),
      host: fakeHost(),
      timeoutMs: 20,
    });

    // Then
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("did not settle within 20ms");
  });

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
