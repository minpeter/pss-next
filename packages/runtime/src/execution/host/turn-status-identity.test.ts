import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import {
  decideTurnClaim,
  decideTurnTransition,
  transitionTurn,
} from "./turn-status";
import type { TurnRecord, TurnStore } from "./types";

const foreignRecord: TurnRecord = {
  checkpointVersion: 0,
  kind: "user-turn",
  rootRunId: "foreign-run",
  runId: "foreign-run",
  status: "queued",
  threadKey: "thread",
};

describe("turn transition identity", () => {
  it("rejects a claim record whose identity differs from the addressed run", () => {
    expect(decideTurnClaim("addressed-run", foreignRecord, 0)).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("rejects a current record whose identity differs from the addressed run", () => {
    expect(
      decideTurnTransition("addressed-run", foreignRecord, {
        status: "queued",
      })
    ).toEqual({ ok: false, reason: "not-found" });
  });

  it("does not update a mismatched record through the legacy store fallback", async () => {
    // Given: a legacy store resolves the addressed key to a foreign record.
    const base = createInMemoryHost();
    let updated = false;
    const turns = legacyMismatchedTurnStore(base.store.turns, () => {
      updated = true;
    });

    // When: the shared fallback attempts a constrained transition.
    const result = await transitionTurn(turns, {
      expected: { status: "queued" },
      runId: "addressed-run",
      update: { status: "running" },
    });

    // Then: corrupt identity fails closed before an unrelated write.
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(updated).toBe(false);
  });
});

function legacyMismatchedTurnStore(
  turns: TurnStore,
  onUpdate: () => void
): TurnStore {
  return new Proxy(turns, {
    get(target, property) {
      if (property === "transition") {
        return;
      }
      if (property === "get") {
        return (runId: string) =>
          Promise.resolve(runId === "addressed-run" ? foreignRecord : null);
      }
      if (property === "update") {
        return (record: TurnRecord) => {
          onUpdate();
          return Promise.resolve(record);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
