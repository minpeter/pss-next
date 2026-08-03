/**
 * Edit tasks shared by every format under comparison.
 *
 * Each task states the goal in prose and pins the exact expected file body, so
 * a format is scored on whether the model's edit produced the right bytes —
 * never on how the edit was phrased. `kind` slices results by change type,
 * following CanItEdit's change-kind reporting.
 */
import type { WorkspaceFileSet } from "./workspace";

export type TaskDifficulty = "easy" | "hard" | "medium";

export interface EditTaskMetadata {
  readonly category: string;
  readonly changedHunks: number;
  readonly contextFeatures: readonly string[];
  readonly difficulty: TaskDifficulty;
  readonly difficultyScore: number;
  readonly language: string;
  readonly seed: number;
  readonly targetLines: readonly number[];
}

interface RawEditTask {
  readonly expected: string;
  readonly id: string;
  readonly initial: string;
  readonly instruction: string;
  readonly kind: string;
  readonly path: string;
}

export interface EditTask extends RawEditTask {
  readonly expectedFiles: WorkspaceFileSet;
  readonly initialFiles: WorkspaceFileSet;
  readonly metadata: EditTaskMetadata;
}

const GREET = `def greet(name):
    msg = "Hello, " + name
    print(msg)
greet("world")
`;

const CLIENT = `const MAX_RETRIES = 3;

export async function fetchWithRetry(url) {
  let attempt = 1;
  while (attempt <= MAX_RETRIES) {
    const response = await fetch(url);
    if (response.ok) {
      return response;
    }
    attempt += 1;
  }
  throw new Error("exhausted retries");
}
`;

const CONFIG = `{
  "name": "demo",
  "version": "1.0.0",
  "private": true
}
`;

const LARGE = `${Array.from(
  { length: 50 },
  (_, index) => `export const value${index + 1} = ${(index + 1) * 3};`
).join("\n")}\n`;

const LARGE_CONDENSED = `${Array.from(
  { length: 29 },
  (_, index) => `export const value${index + 1} = ${(index + 1) * 3};`
).join("\n")}\nexport const condensed = 1;\n${Array.from(
  { length: 12 },
  (_, index) => `export const value${index + 39} = ${(index + 39) * 3};`
).join("\n")}\n`;

const RAW_EDIT_TASKS: readonly RawEditTask[] = [
  {
    expected: `def greet(name):
    greeting = "Hi"
    msg = f"{greeting}, {name}"
    print(msg)
greet("world")
`,
    id: "single-line-to-two",
    initial: GREET,
    instruction:
      'Replace the line `    msg = "Hello, " + name` with these two lines, keeping the four-space indentation:\n    greeting = "Hi"\n    msg = f"{greeting}, {name}"',
    kind: "replace-line",
    path: "greet.py",
  },
  {
    expected: `def greet(name):
    msg = "Hello, " + name
    print(msg)
greet("everyone")
`,
    id: "last-line-replace",
    initial: GREET,
    instruction:
      'Change the last line from `greet("world")` to `greet("everyone")`.',
    kind: "replace-line",
    path: "greet.py",
  },
  {
    expected: `# generated header
def greet(name):
    msg = "Hello, " + name
    print(msg)
greet("world")
`,
    id: "prepend-header",
    initial: GREET,
    instruction:
      "Insert a new first line `# generated header` at the very top of the file. Change nothing else.",
    kind: "insert",
    path: "greet.py",
  },
  {
    expected: `def greet(name):
    msg = "Hello, " + name
    print(msg)
greet("world")
greet("everyone")
`,
    id: "append-call",
    initial: GREET,
    instruction:
      'Append a new final line `greet("everyone")` at the end of the file. Change nothing else.',
    kind: "insert",
    path: "greet.py",
  },
  {
    expected: `def greet(name):
    print(msg)
greet("world")
`,
    id: "delete-middle-line",
    initial: GREET,
    instruction:
      'Remove the line `    msg = "Hello, " + name` entirely, leaving the other lines untouched.',
    kind: "delete",
    path: "greet.py",
  },
  {
    expected: `const MAX_RETRIES = 3;

export async function fetchWithRetry(url) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) {
      return response;
    }
  }
  throw new Error("exhausted retries");
}
`,
    id: "while-to-for-range",
    initial: CLIENT,
    instruction:
      "Rewrite the retry loop as a for loop. Replace the `let attempt = 1;` line through the `attempt += 1;` line with exactly:\n  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {\n    const response = await fetch(url);\n    if (response.ok) {\n      return response;\n    }\n  }\nKeep `const MAX_RETRIES`, the blank line, the function signature, the throw, and the closing brace unchanged.",
    kind: "replace-range",
    path: "client.js",
  },
  {
    expected: `{
  "name": "demo-renamed",
  "version": "2.0.0",
  "private": true
}
`,
    id: "two-disjoint-edits",
    initial: CONFIG,
    instruction:
      'Change the "name" value to "demo-renamed" and the "version" value to "2.0.0". Leave every other line exactly as it is.',
    kind: "multi-hunk",
    path: "config.json",
  },
  {
    expected: `def greet(name):
    msg = "Hello, " + name
    if not name:
        name = "stranger"
    print(msg)
greet("world")
`,
    id: "insert-indented-block",
    instruction:
      'Insert these two lines immediately after the line `    msg = "Hello, " + name`, preserving the exact indentation shown:\n    if not name:\n        name = "stranger"',
    initial: GREET,
    kind: "insert",
    path: "greet.py",
  },
  {
    expected: `function tokenize(input) {
  return input.trim();
}
const out = tokenize(raw);
console.log(tokenize(out));
`,
    id: "rename-symbol",
    initial: `function parse(input) {
  return input.trim();
}
const out = parse(raw);
console.log(parse(out));
`,
    instruction:
      "Rename the function `parse` to `tokenize` everywhere it appears, including the declaration and both call sites. Change nothing else.",
    kind: "rename",
    path: "parse.js",
  },
  {
    expected: `def total(xs):
    acc = 0
    for x in xs:
        acc += x
    print("done")
    return acc
`,
    id: "move-block-up",
    initial: `def total(xs):
    acc = 0
    for x in xs:
        acc += x
    return acc
    print("done")
`,
    instruction:
      'Move the line `    print("done")` so it comes immediately before the `    return acc` line, keeping indentation. Change nothing else.',
    kind: "move",
    path: "total.py",
  },
  {
    expected: `package main

func add(a int, b int) int {
\treturn a + b
}
`,
    id: "tab-indent-replace",
    initial: `package main

func add(a int, b int) int {
\treturn a - b
}
`,
    instruction:
      "Change the return statement to add instead of subtract: `\treturn a + b`. The file uses TAB indentation; keep the tab exactly.",
    kind: "trap",
    path: "calc.go",
  },
  {
    expected: "# header v2\nvalue = 1   \n",
    id: "trailing-ws-preserve",
    initial: "# header\nvalue = 1   \n",
    instruction:
      "Change only the first line to `# header v2`. The second line `value = 1` ends with three trailing spaces; keep them byte-for-byte.",
    kind: "trap",
    path: "notes.txt",
  },
  {
    expected: `GREETING = "Hello, 세계"

def greet():
    print(GREETING)
`,
    id: "unicode-string-replace",
    initial: `GREETING = "안녕하세요"

def greet():
    print(GREETING)
`,
    instruction:
      'Change the GREETING string to `"Hello, 세계"` (mixing English and Korean). Change nothing else.',
    kind: "replace-line",
    path: "greet_ko.py",
  },
  {
    expected: `// anchor 5#QT belongs to line 5
const enabled = true;
// do not edit the comment above
`,
    id: "anchor-text-trap",
    initial: `// anchor 5#QT belongs to line 5
const enabled = false;
// do not edit the comment above
`,
    instruction:
      "Change only the `const enabled = false;` line to `const enabled = true;`. The comments mention an anchor-like token; leave both comment lines untouched.",
    kind: "trap",
    path: "flags.js",
  },
  {
    expected: `${Array.from({ length: 26 }, (_, index) => `export const value${index + 1} = ${(index + 1) * 3};`).join("\n")}\nexport const value27 = 0;\n${Array.from({ length: 23 }, (_, index) => `export const value${index + 28} = ${(index + 28) * 3};`).join("\n")}\n`,
    id: "large-mid-replace",
    initial: LARGE,
    instruction:
      "In this 50-line file, change line 27 from `export const value27 = 81;` to `export const value27 = 0;`. Change nothing else.",
    kind: "replace-line",
    path: "values.js",
  },
  {
    expected: LARGE_CONDENSED,
    id: "large-range-replace",
    initial: LARGE,
    instruction:
      "In this 50-line file, replace lines 30 through 38 (the `value30` through `value38` declarations) with a single line `export const condensed = 1;`. Change nothing else.",
    kind: "replace-range",
    path: "values.js",
  },
  {
    expected: `{
  "name": "demo",
  "release": "1.0.0",
  "private": true,
  "license": "MIT"
}
`,
    id: "json-key-rename",
    initial: `{
  "name": "demo",
  "version": "1.0.0",
  "private": true,
  "license": "MIT"
}
`,
    instruction:
      'Rename the JSON key "version" to "release", keeping its value, position, and indentation exactly. Change nothing else.',
    kind: "rename",
    path: "release.json",
  },
  {
    expected: `def clamp(xs):
    if not xs:
        return 0
    total = 0
    for x in xs:
        total += x
    return total
`,
    id: "py-dedent-block",
    initial: `def clamp(xs):
    total = 0
    if xs:
        for x in xs:
            total += x
    return total
`,
    instruction:
      "Restructure the function body with a guard clause. Replace the body (lines 2 through 5) with:\n    if not xs:\n        return 0\n    total = 0\n    for x in xs:\n        total += x\n    return total",
    kind: "replace-range",
    path: "clamp.py",
  },
  {
    expected: `class Cart:
    def __init__(self):
        self.items = []
    def total(self):
        return sum(self.items)
`,
    id: "py-append-method",
    initial: `class Cart:
    def __init__(self):
        self.items = []
`,
    instruction:
      "Append a new method at the end of the class:\n    def total(self):\n        return sum(self.items)\nKeep the exact four-space indentation.",
    kind: "insert",
    path: "cart.py",
  },
  {
    expected: `package main

import "fmt"

func main() {
\tfmt.Printf("sum=%d\\n", total)
}
`,
    id: "go-line-replace",
    initial: `package main

import "fmt"

func main() {
\tfmt.Printf("total=%d\\n", total)
}
`,
    instruction:
      'Change the format string in the Printf call from `"total=%d\\n"` to `"sum=%d\\n"`. Keep the tab indentation and the escaped newline exactly.',
    kind: "replace-line",
    path: "main.go",
  },
  {
    expected: `fn compute(x: i32) -> i32 {
    x * 2
}

fn main() {
    compute(21)
}
`,
    id: "rust-fn-rename",
    initial: `fn calc(x: i32) -> i32 {
    x * 2
}

fn main() {
    calc(21)
}
`,
    instruction:
      "Rename the function `calc` to `compute` in both the declaration and the call in main. Change nothing else.",
    kind: "rename",
    path: "calc.rs",
  },
  {
    expected: `# Shopping

- first item
- second item
- third item
`,
    id: "md-bullet-insert",
    initial: `# Shopping

- first item
- second item
`,
    instruction:
      "Insert a new bullet `- third item` immediately after the `- second item` line. Change nothing else.",
    kind: "insert",
    path: "README.md",
  },
  {
    expected: `print("hello")
`,
    id: "delete-first-line",
    initial: `#!/usr/bin/env python3
print("hello")
`,
    instruction:
      "Delete the shebang line at the very top of the file, leaving only the print line.",
    kind: "delete",
    path: "script.py",
  },
  {
    expected: `const a = 1;

const b = 2;
const c = 3;
`,
    id: "insert-after-blank",
    initial: `const a = 1;

const c = 3;
`,
    instruction:
      "Insert the line `const b = 2;` so it sits between the blank line and the `const c = 3;` line. Change nothing else.",
    kind: "insert",
    path: "vars.js",
  },
  {
    expected: `export const endpoint = "https://api.example.test/v2";
`,
    id: "multi-file-import",
    initial: `export const endpoint = "https://api.example.test/v1";
`,
    instruction:
      "In src/config.ts, change the endpoint suffix from `/v1` to `/v2`. Do not modify src/main.ts or create any other files.",
    kind: "replace",
    path: "src/config.ts",
  },
];

export const EDIT_TASKS: readonly EditTask[] = RAW_EDIT_TASKS.map((task) => {
  const initialFiles =
    task.id === "multi-file-import"
      ? {
          "src/config.ts": task.initial,
          "src/main.ts":
            'import { endpoint } from "./config";\nconsole.log(endpoint);\n',
        }
      : { [task.path]: task.initial };
  const expectedFiles =
    task.id === "multi-file-import"
      ? {
          "src/config.ts": task.expected,
          "src/main.ts":
            'import { endpoint } from "./config";\nconsole.log(endpoint);\n',
        }
      : { [task.path]: task.expected };
  return {
    ...task,
    expectedFiles,
    initialFiles,
    metadata: metadataFor(task),
  };
});

function metadataFor(task: RawEditTask): EditTaskMetadata {
  const lineCount = task.initial.split("\n").length - 1;
  const difficultyScore = difficultyScoreFor(lineCount);
  const initialLines = task.initial.split("\n");
  const expectedLines = task.expected.split("\n");
  const targetLines = Array.from(
    { length: Math.max(initialLines.length, expectedLines.length) },
    (_, index) => index
  )
    .filter((index) => initialLines[index] !== expectedLines[index])
    .map((index) => index + 1);
  const contextFeatures = [
    ...(lineCount > 30 ? ["long-context"] : []),
    ...(new Set(initialLines).size < initialLines.length - 1
      ? ["repeated-lines"]
      : []),
    ...(containsNonAscii(task.initial) ? ["unicode"] : []),
    ...(task.initial.includes("\t") ? ["tabs"] : []),
  ];
  return {
    category: task.kind,
    changedHunks: countContiguousRanges(targetLines),
    contextFeatures,
    difficulty: difficultyFor(difficultyScore),
    difficultyScore,
    language: languageFor(task.path),
    seed: stableSeed(task.id),
    targetLines,
  };
}

function difficultyScoreFor(lineCount: number): number {
  if (lineCount > 30) {
    return 3;
  }
  return lineCount > 8 ? 2 : 1;
}

function difficultyFor(score: number): TaskDifficulty {
  if (score === 1) {
    return "easy";
  }
  return score === 2 ? "medium" : "hard";
}

function containsNonAscii(value: string): boolean {
  return Array.from(value).some(
    (character) => (character.codePointAt(0) ?? 0) > 127
  );
}

function countContiguousRanges(lines: readonly number[]): number {
  let ranges = 0;
  let previous: number | undefined;
  for (const line of lines) {
    if (previous === undefined || line !== previous + 1) {
      ranges += 1;
    }
    previous = line;
  }
  return ranges;
}

function languageFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "go":
      return "go";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "ts":
      return "typescript";
    case "txt":
      return "text";
    default:
      return "javascript";
  }
}

function stableSeed(value: string): number {
  let seed = 0;
  for (const character of value) {
    seed = (seed * 31 + (character.codePointAt(0) ?? 0)) % 4_294_967_296;
  }
  return seed;
}
