import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CodingAgentExtensionState, ExtensionJsonValue } from "./types";

export function createExtensionJsonState(options: {
  readonly extensionId: string;
  readonly root: string;
  /**
   * Reports whether writes are revoked. Revocation happens after all
   * registered cleanups ran (or were detached by a timeout), so ordinary
   * cleanup can persist final state while detached post-disposal work
   * cannot overwrite state that a replacement runtime now owns.
   */
  readonly isRevoked?: () => boolean;
}): CodingAgentExtensionState {
  const path = join(
    options.root,
    `${encodeURIComponent(options.extensionId)}.json`
  );
  let queue = Promise.resolve();
  const enqueue = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  const assertWritable = (): void => {
    if (options.isRevoked?.()) {
      throw new Error(
        `Extension "${options.extensionId}" state is read-only after its runtime was disposed`
      );
    }
  };

  const state: CodingAgentExtensionState = {
    clear: () =>
      enqueue(async () => {
        assertWritable();
        await assertNotSymbolicLink(path);
        await rm(path, { force: true });
      }),
    get: () => enqueue(() => readState(path)),
    set: (value: ExtensionJsonValue) =>
      enqueue(async () => {
        assertWritable();
        assertJsonValue(value, "Extension state");
        await writeState(path, value);
      }),
    update: (updater: Parameters<CodingAgentExtensionState["update"]>[0]) =>
      enqueue(async () => {
        assertWritable();
        const next = await updater(await readState(path));
        assertJsonValue(next, "Extension state");
        assertWritable();
        await writeState(path, next);
        return next;
      }),
  };
  return Object.freeze(state);
}

export function assertJsonValue(
  value: unknown,
  label: string
): asserts value is ExtensionJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonValue(item, label);
    }
    return;
  }
  if (
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must contain only JSON data`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new TypeError(`${label} must not contain symbol properties`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${label} must contain only data properties`);
    }
    assertJsonValue(descriptor.value, label);
  }
}

async function readState(
  path: string
): Promise<ExtensionJsonValue | undefined> {
  try {
    await assertNotSymbolicLink(path);
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    assertJsonValue(parsed, "Extension state");
    return parsed;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    if (error instanceof SyntaxError) {
      throw new TypeError(`Invalid extension state at ${path}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function writeState(
  path: string,
  value: ExtensionJsonValue
): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await assertNotSymbolicLink(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function assertNotSymbolicLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new TypeError(
        `Extension state path must not be a symbolic link: ${path}`
      );
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code;
}
