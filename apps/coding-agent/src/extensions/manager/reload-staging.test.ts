import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginExtensionStagingSession,
  type ExtensionStagingSession,
} from "./reload-staging";

const STAGED_IMPORT_FAILURE = /Staged extension import failed .*boom at import/;
const DISPOSED = /disposed/;
const DISPOSED_OR_EXITED = /disposed|exited/;

let root: string;
let session: ExtensionStagingSession;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pss-reload-staging-"));
  session = beginExtensionStagingSession();
});

afterEach(async () => {
  await session.dispose();
  await rm(root, { force: true, recursive: true });
});

async function writeModule(name: string, source: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, source);
  return pathToFileURL(path).href;
}

describe("beginExtensionStagingSession", () => {
  it("reports factory-shaped default exports with a callable stub", async () => {
    const specifier = await writeModule(
      "factory.mjs",
      "export default () => {};"
    );
    const namespace = (await session.importer(specifier)) as {
      default: unknown;
    };
    expect(typeof namespace.default).toBe("function");
  });

  it("reports extension-shaped exports with their id", async () => {
    const specifier = await writeModule(
      "extension.mjs",
      'export default { id: "sample", configure: () => {} };'
    );
    const namespace = (await session.importer(specifier)) as {
      default: { configure: unknown; id: string };
    };
    expect(namespace.default.id).toBe("sample");
    expect(typeof namespace.default.configure).toBe("function");
  });

  it("mirrors invalid exports so loader validation fails at staging time", async () => {
    const specifier = await writeModule("invalid.mjs", "export default 42;");
    const namespace = (await session.importer(specifier)) as {
      default: unknown;
    };
    expect(namespace.default).toBeUndefined();
  });

  it("fails staged imports of modules that throw at module scope", async () => {
    const specifier = await writeModule(
      "broken.mjs",
      'throw new Error("boom at import");'
    );
    await expect(session.importer(specifier)).rejects.toThrow(
      STAGED_IMPORT_FAILURE
    );
  });

  it("keeps module side effects isolated from the main context", async () => {
    const marker = `pss-staging-isolated-${Date.now()}`;
    const specifier = await writeModule(
      "side-effect.mjs",
      `globalThis[${JSON.stringify(marker)}] = true; export default () => {};`
    );
    await session.importer(specifier);
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
  });

  it("reports CommonJS modules introduced by a candidate graph", async () => {
    await writeModule("helper.cjs", "module.exports = {};\n");
    const specifier = await writeModule(
      "uses-commonjs.mjs",
      'import "./helper.cjs"; export default () => {};'
    );

    await session.importer(specifier);

    expect(session.commonJsPaths()).toContain(join(root, "helper.cjs"));
  });

  it("rejects imports after disposal", async () => {
    const specifier = await writeModule("late.mjs", "export default () => {};");
    await session.dispose();
    await expect(session.importer(specifier)).rejects.toThrow(DISPOSED);
  });

  it("fails pending imports when the session is disposed mid-flight", async () => {
    const specifier = await writeModule(
      "hang.mjs",
      "await new Promise(() => {}); export default () => {};"
    );
    const pending = session.importer(specifier);
    const raced = expect(pending).rejects.toThrow(DISPOSED_OR_EXITED);
    await session.dispose();
    await raced;
  });
});
