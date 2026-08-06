import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findTegamiNoteErrors } from "./check-tegami-notes.mjs";

const fixtures = [];

function createFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "tegami-notes-"));
  mkdirSync(join(cwd, ".tegami"), { recursive: true });
  fixtures.push(cwd);
  return cwd;
}

function writeNote(cwd, name, content) {
  writeFileSync(join(cwd, ".tegami", name), content);
}

afterEach(() => {
  for (const cwd of fixtures.splice(0)) {
    rmSync(cwd, { force: true, recursive: true });
  }
});

describe("check-tegami-notes", () => {
  it("accepts a pending entry with a heading section", () => {
    const cwd = createFixture();
    writeNote(
      cwd,
      "2026-08-07-good.md",
      "---\npackages:\n  npm:@example/pkg:\n    type: patch\n---\n\n## Add the thing\n\nBody text.\n"
    );
    expect(findTegamiNoteErrors(cwd)).toEqual([]);
  });

  it("rejects a pending entry without any heading", () => {
    const cwd = createFixture();
    writeNote(
      cwd,
      "2026-08-07-bad.md",
      "---\npackages:\n  npm:@example/pkg:\n    type: minor\n---\n\nBody text without sections.\n"
    );
    const errors = findTegamiNoteErrors(cwd);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("2026-08-07-bad.md");
    expect(errors[0]).toContain("## <Title>");
  });

  it("ignores replay-only entries that never bump a version", () => {
    const cwd = createFixture();
    writeNote(
      cwd,
      "2026-08-07-replay.md",
      "---\npackages:\n  npm:@example/pkg:\n    replay:\n      - exit-prerelease(npm:@example/pkg)\n---\n\nDocs-only body without sections.\n"
    );
    expect(findTegamiNoteErrors(cwd)).toEqual([]);
  });

  it("does not count headings inside fenced code blocks, matching tegami", () => {
    const cwd = createFixture();
    writeNote(
      cwd,
      "2026-08-07-fenced.md",
      "---\npackages:\n  npm:@example/pkg:\n    type: patch\n---\n\n```md\n## Not a section\n```\n"
    );
    expect(findTegamiNoteErrors(cwd)).toHaveLength(1);
  });

  it("accepts heading depths other than level two", () => {
    const cwd = createFixture();
    writeNote(
      cwd,
      "2026-08-07-deep.md",
      "---\npackages:\n  npm:@example/pkg:\n    type: patch\n---\n\n### Deeper title\n\nBody.\n"
    );
    expect(findTegamiNoteErrors(cwd)).toEqual([]);
  });

  it("ignores non-markdown files like the publish lock", () => {
    const cwd = createFixture();
    writeFileSync(join(cwd, ".tegami", "publish-lock.yaml"), "core: {}\n");
    expect(findTegamiNoteErrors(cwd)).toEqual([]);
  });

  it("finds no problems in the real repository notes", () => {
    expect(findTegamiNoteErrors()).toEqual([]);
  });
});
