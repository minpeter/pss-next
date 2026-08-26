import type { ThreadStateMigration } from "../../thread/state/migrations";

export function assertThreadStateMigrationList(
  value: unknown
): asserts value is readonly ThreadStateMigration[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(
      "Agent: options.threadMigrations must be an array of migrations."
    );
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !(
      lengthDescriptor &&
      "value" in lengthDescriptor &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value >= 0
    )
  ) {
    throw new TypeError(
      "Agent: options.threadMigrations must be a dense array of data-property migrations."
    );
  }
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && "value" in descriptor)) {
      throw new TypeError(
        "Agent: options.threadMigrations must be a dense array of data-property migrations."
      );
    }
    if (!isThreadStateMigration(descriptor.value)) {
      throw new TypeError(
        "Agent: options.threadMigrations must be an array of migrations."
      );
    }
  }
}

function isThreadStateMigration(value: unknown): value is ThreadStateMigration {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    "version" in value &&
    typeof value.version === "number" &&
    "migrate" in value &&
    typeof value.migrate === "function"
  );
}
