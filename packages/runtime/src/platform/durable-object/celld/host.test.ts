import { describe, expect, it } from "vitest";
import { describeAgentHostFaultContract } from "../../../contracts/agent-host-fault-contract";
import { createCelldTestStorage } from "./celld-test-storage";
import { createCelldHost } from "./host";

let hostPrefix = 0;

describeAgentHostFaultContract({
  createHost: () => ({
    host: createCelldHost({
      prefix: `celld-host-contract-${hostPrefix++}`,
      state: createState(),
    }),
  }),
  name: "Celld",
});

describe("createCelldHost", () => {
  it("composes Cloudflare storage ports with the Celld scheduler", async () => {
    const state = createState();
    const host = createCelldHost({ state });

    expect(host.store).toBeDefined();
    expect(host.attachmentStore).toBeDefined();
    expect(host.diagnostics).toBeDefined();
    expect(host.scheduler).toBeDefined();

    await host.scheduler.enqueueRun("celld-run");

    await expect(state.storage.getAlarm()).resolves.toBeDefined();
  });

  it("requires no Cloudflare Agents SDK object or fiber", () => {
    const host = createCelldHost({ state: createState() });

    expect(host.scheduler).toBeDefined();
  });

  it("reconciles persisted scheduled work during activation", async () => {
    const state = createState();
    state.storage.sql.exec(
      "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, thread_key, run_id, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "pss-runtime",
      "celld-run",
      "orphaned",
      JSON.stringify({ dueAtMs: 42, value: "orphaned" }),
      null,
      "orphaned",
      42,
      42
    );

    createCelldHost({ clock: () => 42, state });
    await Promise.all(state.waits);

    await expect(state.storage.getAlarm()).resolves.toBe(42);
  });
});

function createState() {
  const storage = createCelldTestStorage();
  const waits: Promise<unknown>[] = [];
  return {
    storage,
    waits,
    waitUntil: (promise: Promise<unknown>): void => {
      waits.push(promise);
    },
  };
}
