import { describe, expect, it } from "vitest";
import { createCallbackModel } from "../../testing/test-fixtures";
import type { ThreadStateMigration } from "../../thread/state/migrations";
import { assertAgentOptions } from "./options";

const migration: ThreadStateMigration = {
  id: "dense-boundary",
  migrate: (snapshot) => snapshot,
  version: 1,
};
const denseArrayPattern = /dense array of data-property migrations/u;

describe("AgentOptions.threadMigrations", () => {
  it.each([
    {
      migrations: new Array<ThreadStateMigration>(1),
      name: "a hole",
    },
    {
      migrations: inheritedMigrationArray(),
      name: "an inherited numeric index",
    },
  ])("rejects $name", ({ migrations }) => {
    expect(() =>
      assertAgentOptions({
        model: createCallbackModel(() => []),
        threadMigrations: migrations,
      })
    ).toThrow(denseArrayPattern);
  });
});

function inheritedMigrationArray(): ThreadStateMigration[] {
  const migrations = new Array<ThreadStateMigration>(1);
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, "0", { value: migration });
  Object.setPrototypeOf(migrations, prototype);
  return migrations;
}
