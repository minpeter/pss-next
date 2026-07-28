import { describe, expect, it } from "vitest";
import type { LoadedConfiguredExtensions } from "../extensions";
import type { TuiCommand } from "./command";
import {
  buildReloadedExtensionRuntime,
  disposePreviousExtensionRuntime,
  type ExtensionRuntimeInstallation,
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
const revertFailedPattern = /could not be reverted/u;

const command: TuiCommand = {
  description: "noop",
  execute: () => ({ success: true }),
  name: "noop",
};

function fakeInstallation(): ExtensionRuntimeInstallation<FakeAgent, FakeHost> {
  return {
    agent: fakeAgent(),
    commands: [command],
    host: fakeHost(),
    toolRenderers: {},
  };
}

function baseOptions(overrides: {
  readonly activateHost?: (host: FakeHost, agent: FakeAgent) => Promise<void>;
  readonly createAgent?: () => Promise<FakeAgent>;
  readonly createHost?: () => Promise<FakeHost>;
  readonly disposePrevious?: () => Promise<readonly string[]>;
  readonly installRuntime?: (
    runtime: ReturnType<typeof fakeInstallation>
  ) => void;
  readonly loadExtensions?: () => Promise<
    LoadedConfiguredExtensions & { rollbackModuleCache?: () => void }
  >;
  readonly mergeCommands?: () => readonly TuiCommand[];
  readonly recoverPrevious?: () => Promise<ReturnType<typeof fakeInstallation>>;
  readonly snapshotState?: () => Promise<{
    discard(): Promise<void>;
    restore(): Promise<void>;
  }>;
  readonly validateHost?: () => Promise<(() => Promise<void>) | undefined>;
}) {
  return {
    activateHost: overrides.activateHost ?? (() => Promise.resolve()),
    createAgent: overrides.createAgent ?? (() => Promise.resolve(fakeAgent())),
    createHost: overrides.createHost ?? (() => Promise.resolve(fakeHost())),
    disposePrevious:
      overrides.disposePrevious ??
      (() => Promise.resolve([] as readonly string[])),
    installRuntime: overrides.installRuntime ?? (() => undefined),
    loadExtensions: overrides.loadExtensions ?? (() => Promise.resolve(loaded)),
    mergeCommands: overrides.mergeCommands ?? (() => [command]),
    mergeToolRenderers: () => ({}),
    recoverPrevious:
      overrides.recoverPrevious ?? (() => Promise.resolve(fakeInstallation())),
    ...(overrides.snapshotState === undefined
      ? {}
      : { snapshotState: overrides.snapshotState }),
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
        installRuntime: () => {
          order.push("install");
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
          return Promise.resolve(undefined);
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
      "install",
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
    // Validation itself failed, so there is nothing to revert.
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

  it("reverts committed validation side effects when activation fails", async () => {
    // Given
    const reverts: boolean[] = [];

    // When / Then
    await expect(
      buildReloadedExtensionRuntime<FakeAgent, FakeHost>(
        baseOptions({
          activateHost: () => Promise.reject(new Error("activation exploded")),
          validateHost: () =>
            Promise.resolve(() => {
              reverts.push(true);
              return Promise.resolve();
            }),
        })
      )
    ).rejects.toThrow("activation exploded");
    expect(reverts).toEqual([true]);
  });

  it("reverts validation when agent creation fails after the commit", async () => {
    // Given
    const reverts: boolean[] = [];

    // When / Then
    await expect(
      buildReloadedExtensionRuntime<FakeAgent, FakeHost>(
        baseOptions({
          createAgent: () => Promise.reject(new Error("agent exploded")),
          validateHost: () =>
            Promise.resolve(() => {
              reverts.push(true);
              return Promise.resolve();
            }),
        })
      )
    ).rejects.toThrow("agent exploded");
    expect(reverts).toEqual([true]);
  });

  it("recovers the previous runtime when activation fails", async () => {
    // Given
    const host = fakeHost();
    const agent = fakeAgent();
    const rollbacks: boolean[] = [];
    const recoveries: boolean[] = [];
    const recovered = fakeInstallation();
    const installed: ReturnType<typeof fakeInstallation>[] = [];

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
          installRuntime: (runtime) => {
            installed.push(runtime);
          },
          recoverPrevious: () => {
            recoveries.push(true);
            return Promise.resolve(recovered);
          },
        })
      )
    ).rejects.toThrow("activation exploded");
    expect(agent.disposed).toEqual([true]);
    expect(host.disposed).toEqual([true]);
    expect(rollbacks).toEqual([true]);
    expect(recoveries).toEqual([true]);
    expect(installed).toEqual([recovered]);
  });

  it("recovers the previous runtime even when the migration revert fails", async () => {
    // Given
    const recoveries: boolean[] = [];

    // When / Then
    await expect(
      buildReloadedExtensionRuntime<FakeAgent, FakeHost>(
        baseOptions({
          activateHost: () => Promise.reject(new Error("activation exploded")),
          recoverPrevious: () => {
            recoveries.push(true);
            return Promise.resolve(fakeInstallation());
          },
          validateHost: () =>
            Promise.resolve(() =>
              Promise.reject(new Error("revert conflicted"))
            ),
        })
      )
    ).rejects.toThrow(revertFailedPattern);
    expect(recoveries).toEqual([true]);
  });

  it("restores the state snapshot on activation failure and discards it on success", async () => {
    // Given
    const events: string[] = [];
    const snapshotState = () =>
      Promise.resolve({
        discard: () => {
          events.push("discard");
          return Promise.resolve();
        },
        restore: () => {
          events.push("restore");
          return Promise.resolve();
        },
      });

    // When — success discards.
    await buildReloadedExtensionRuntime<FakeAgent, FakeHost>(
      baseOptions({ snapshotState })
    );
    // When / Then — activation failure restores.
    await expect(
      buildReloadedExtensionRuntime<FakeAgent, FakeHost>(
        baseOptions({
          activateHost: () => Promise.reject(new Error("activation exploded")),
          snapshotState,
        })
      )
    ).rejects.toThrow("activation exploded");
    expect(events).toEqual(["discard", "restore"]);
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
