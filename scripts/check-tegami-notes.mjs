#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const TEGAMI_DIRECTORY = ".tegami";
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const EXPLICIT_BUMP_RE = /^\s*type:\s*(patch|minor|major)\s*$/m;
// Mirrors tegami's parseHeading: ATX headings only, at most 3 leading spaces.
const HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const LINE_SPLIT_RE = /\r\n|\r|\n/;

// Tegami drafts a pending note into the Version Packages PR only when the
// body parses into at least one markdown section, which requires one heading
// outside fenced code (see parseMarkdownSections in tegami's publish module).
// A note with an explicit type: bump but no heading is silently unreleasable.
function hasVisibleSection(body) {
  let fence;
  for (const line of body.split(LINE_SPLIT_RE)) {
    const fenceMarker = line.match(FENCE_RE);
    if (fenceMarker) {
      const marker = fenceMarker[1];
      if (!fence) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (!fence && HEADING_RE.test(line)) {
      return true;
    }
  }
  return false;
}

export function findTegamiNoteErrors(cwd = process.cwd()) {
  const directory = join(cwd, TEGAMI_DIRECTORY);
  const errors = [];
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".md")) {
      continue;
    }
    const text = readFileSync(join(directory, file), "utf8");
    const frontmatter = text.match(FRONTMATTER_RE);
    if (!(frontmatter && EXPLICIT_BUMP_RE.test(frontmatter[1]))) {
      // Not pending: replay-only notes never bump a version, and notes
      // without an explicit type carry no release intent to guard.
      continue;
    }
    if (!hasVisibleSection(text.slice(frontmatter[0].length))) {
      errors.push(
        `${TEGAMI_DIRECTORY}/${file}: pending entry has no markdown heading; tegami skips notes without a section, so this change would never be released. Add a '## <Title>' section above the body.`
      );
    }
  }
  return errors;
}

export function main() {
  const errors = findTegamiNoteErrors();
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    return 1;
  }
  console.log("All pending tegami entries have a visible section heading");
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
