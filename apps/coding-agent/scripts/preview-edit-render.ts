/**
 * Visual preview of the edit_file hashline diff renderer.
 * allow: SIZE_OK — self-contained dev showcase script; most of its size is
 * the inline example fixture table, and it is never imported by src/.
 *
 * Runs real edit_file calls against fixture files in a temp workspace, then
 * prints both the raw tool output (diff section) and the TUI-rendered pretty
 * block with true ANSI colors, so the highlighting can be eyeballed in a
 * real terminal:
 *
 *   pnpm --filter @minpeter/pss-coding-agent preview:edit
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { createToolRenderers } from "../src/tui/renderers/tool-renderers";
import { BaseToolCallView } from "../src/tui/tool-call-view";
import { createWorkspaceTools } from "../src/workspace-tools/index";

const plainTheme: MarkdownTheme = {
  heading: (t) => t,
  link: (t) => t,
  linkUrl: (t) => t,
  code: (t) => t,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => t,
  quote: (t) => t,
  quoteBorder: (t) => t,
  hr: (t) => t,
  listBullet: (t) => t,
  bold: (t) => t,
  italic: (t) => t,
  strikethrough: (t) => t,
  underline: (t) => t,
};

interface EditInput {
  end?: string;
  lines: string[];
  op: "append" | "prepend" | "replace";
  pos?: string;
}

interface Example {
  readonly buildEdits: (anchor: (lineNo: number) => string) => EditInput[];
  readonly fileName: string;
  readonly initial: string;
  readonly name: string;
}

const WHILE_LOOP_CLIENT = `import { join } from "node:path";
import { readFile } from "node:fs/promises";

export const MAX_RETRIES = 3;
export const DEFAULT_BASE_URL = "https://api.example.dev";

export interface FetchResult {
  readonly status: number;
  readonly body: string;
}

// fetchWithRetry returns the first successful response
export async function fetchWithRetry(url: string): Promise<FetchResult> {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    const response = await fetch(url);
    if (response.ok) {
      const body = await response.text();
      return { status: response.status, body };
    }
    attempt += 1;
  }
  throw new Error(\`giving up after \${MAX_RETRIES} attempts: \${url}\`);
}

export function resolveCachePath(key: string): string {
  const safeKey = key.replace(/[^a-z0-9]/gi, "_");
  return join(".cache", \`\${safeKey}.json\`);
}
`;

const examples: Example[] = [
  {
    name: "single-line intra-token change",
    fileName: "counters.ts",
    initial: "export const first = 1;\nexport const second = 2;\n",
    buildEdits: (anchor) => [
      { lines: ["export const second = 3;"], op: "replace", pos: anchor(2) },
    ],
  },
  {
    name: "range replace with an end anchor",
    fileName: "lines.txt",
    initial: "line one\nline two\nline three\n",
    buildEdits: (anchor) => [
      {
        end: anchor(2),
        lines: ["line uno", "line dos"],
        op: "replace",
        pos: anchor(1),
      },
    ],
  },
  {
    name: "bare append at end of file",
    fileName: "list.txt",
    initial: "alpha\nbeta\n",
    buildEdits: () => [{ lines: ["gamma"], op: "append" }],
  },
  {
    name: "prepend before an anchored line",
    fileName: "stack.txt",
    initial: "beta\ngamma\n",
    buildEdits: (anchor) => [
      { lines: ["middle"], op: "prepend", pos: anchor(2) },
    ],
  },
  {
    name: "partial token change (shared prefix tinted)",
    fileName: "names.ts",
    initial: 'const name = "alpha";\n',
    buildEdits: (anchor) => [
      { lines: ['const name = "alpine";'], op: "replace", pos: anchor(1) },
    ],
  },
  {
    name: "indented additions (whitespace tinted, never glowing)",
    fileName: "main.ts",
    initial: "export function main(): void {\n}\n",
    buildEdits: (anchor) => [
      { lines: ["  doThing();", "}"], op: "replace", pos: anchor(2) },
    ],
  },
  {
    name: "shrinking a block (surplus removals glow whole)",
    fileName: "math.ts",
    initial: [
      "export function add(a: number, b: number): number {",
      "  const sum = a + b;",
      '  console.log("adding", a, b);',
      "  return sum;",
      "}",
      "",
    ].join("\n"),
    buildEdits: (anchor) => [
      {
        end: anchor(4),
        lines: ["  return a + b;"],
        op: "replace",
        pos: anchor(2),
      },
    ],
  },
  {
    name: "multi-hunk edit across one call",
    fileName: "greet.ts",
    initial: [
      'import { join } from "node:path";',
      "",
      "export const MAX_RETRIES = 3;",
      "",
      "// greet returns a friendly message",
      "export function greet(name: string): string {",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture code contains template syntax
      "  return `hello ${name}`;",
      "}",
      "",
    ].join("\n"),
    buildEdits: (anchor) => [
      {
        lines: ["export const MAX_RETRIES = 5;"],
        op: "replace",
        pos: anchor(3),
      },
      {
        lines: ["// greet returns a warm message"],
        op: "replace",
        pos: anchor(5),
      },
      { lines: ["export default greet;"], op: "append" },
    ],
  },
  {
    name: "while-to-for loop rewrite in a client module",
    fileName: "client.ts",
    initial: WHILE_LOOP_CLIENT,
    buildEdits: (anchor) => [
      {
        end: anchor(21),
        lines: [
          "  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {",
          "    const response = await fetch(url);",
          "    if (response.ok) {",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture code contains template syntax
          "      console.log(`fetched ${url} on attempt ${attempt}`);",
          "      const body = await response.text();",
          "      return { status: response.status, body };",
          "    }",
          "  }",
        ],
        op: "replace",
        pos: anchor(14),
      },
      {
        lines: ['export const DEFAULT_BASE_URL = "https://api.example.com";'],
        op: "replace",
        pos: anchor(5),
      },
      {
        lines: ["export default fetchWithRetry;"],
        op: "append",
      },
    ],
  },
];

const anchorFor = (readOutput: string, lineNo: number): string => {
  const anchor = new RegExp(`${lineNo}#[ZPMQVRWSNKTXJBYH]{2}(?=\\|)`, "u").exec(
    readOutput
  )?.[0];
  if (anchor === undefined) {
    throw new Error(`No hashline anchor for line ${lineNo}.`);
  }
  return anchor;
};

const options = {
  context: {},
  messages: [],
  toolCallId: "preview",
} as const;

const renderExample = async (
  workspace: string,
  example: Example,
  width: number
): Promise<void> => {
  await writeFile(join(workspace, example.fileName), example.initial, "utf8");
  const tools = createWorkspaceTools({ workspace });
  const read = tools.read_file?.execute;
  const edit = tools.edit_file?.execute;
  if (typeof read !== "function" || typeof edit !== "function") {
    throw new TypeError("Expected executable read_file/edit_file tools.");
  }

  const readOutput = String(await read({ path: example.fileName }, options));
  const anchor = (lineNo: number): string => anchorFor(readOutput, lineNo);
  const input = {
    edits: example.buildEdits(anchor),
    path: example.fileName,
  };
  const editOutput = String(await edit(input, options));

  const view = new BaseToolCallView(
    "preview",
    "edit_file",
    plainTheme,
    () => undefined,
    false,
    createToolRenderers()
  );
  view.setFinalInput(input);
  view.setOutput(editOutput);
  const rendered = view.render(width).join("\n");

  process.stdout.write(
    `\n### ${example.name} (${example.fileName})\n\n--- edit_file input ---\n${JSON.stringify(input, null, 2)}\n\n--- raw edit_file output ---\n${editOutput}\n\n--- TUI pretty block ---\n${rendered}\n`
  );
};

const main = async (): Promise<void> => {
  const workspace = await mkdtemp(join(tmpdir(), "pss-edit-preview-"));
  try {
    const width = Math.min(process.stdout.columns || 100, 120);
    process.stdout.write(
      `\nedit_file renderer preview — ${examples.length} examples at width ${width}\n`
    );
    for (const example of examples) {
      await renderExample(workspace, example, width);
    }
    process.stdout.write("\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

await main();
