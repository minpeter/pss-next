import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { ToolExecutionOptions } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolRenderers } from "./tui/renderers/tool-renderers";
import { BaseToolCallView } from "./tui/tool-call-view";
import { computeFileHash } from "./workspace-tools/hashline";
import { createWorkspaceTools } from "./workspace-tools/index";

const executionOptions: ToolExecutionOptions<Record<string, unknown>> = {
  context: {},
  messages: [],
  toolCallId: "edit-file-flow-test",
};

const theme: MarkdownTheme = {
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

// senpi dark-theme diff scheme, mirrored from tui/renderers so the
// assertions read as "what the user sees" rather than implementation trivia.
const REMOVE_FG = "\x1b[31m";
const ADD_FG = "\x1b[32m";
const DIM = "\x1b[2m";
const INVERSE_ON = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";
const REMOVE_FAINT_BG = "\x1b[48;2;61;38;40m";
const ADD_FAINT_BG = "\x1b[48;2;38;61;40m";
const GRAY_BG = "\x1b[100m";
const SYN_KEYWORD = "\x1b[38;2;86;156;214m";
const SYN_COMMENT = "\x1b[38;2;106;153;85m";
const SYN_STRING = "\x1b[38;2;206;145;120m";

const anchorPattern = (lineNo: number): RegExp =>
  new RegExp(`${lineNo}#[ZPMQVRWSNKTXJBYH]{2}(?=\\|)`, "u");

const anchorFor = (readOutput: string, lineNo: number): string => {
  const anchor = anchorPattern(lineNo).exec(readOutput)?.[0];
  if (anchor === undefined) {
    throw new Error(`No hashline anchor for line ${lineNo} in read output.`);
  }
  return anchor;
};

const FILE_HASH_PATTERN = /file_hash: ([0-9a-f]{8})/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching rendered ANSI output requires the literal ESC character
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/gu;

const fileHashOf = (readOutput: string): string => {
  const fileHash = FILE_HASH_PATTERN.exec(readOutput)?.[1];
  if (fileHash === undefined) {
    throw new Error("No file_hash in read output.");
  }
  return fileHash;
};

interface EditInput {
  end?: string;
  lines: string[];
  op: "append" | "prepend" | "replace";
  pos?: string;
}

interface Scenario {
  readonly buildEdits: (anchor: (lineNo: number) => string) => EditInput[];
  readonly checkRendered?: (rendered: string) => void;
  readonly expectedFile: string;
  readonly expectRender: {
    readonly contains: readonly string[];
    readonly notContains: readonly string[];
  };
  readonly initial: string;
  readonly name: string;
  readonly useExpectedFileHash?: boolean;
}

const scenarios: Scenario[] = [
  {
    name: "single-line replace highlights only the changed token",
    initial: "export const first = 1;\nexport const second = 2;\n",
    buildEdits: (anchor) => [
      { lines: ["export const second = 3;"], op: "replace", pos: anchor(2) },
    ],
    expectedFile: "export const first = 1;\nexport const second = 3;\n",
    useExpectedFileHash: true,
    expectRender: {
      contains: [
        `${REMOVE_FG}-2 `,
        `${ADD_FG}+2 `,
        `${REMOVE_FG}${INVERSE_ON}2${INVERSE_OFF}`,
        `${ADD_FG}${INVERSE_ON}3${INVERSE_OFF}`,
        `${SYN_KEYWORD}export`,
      ],
      notContains: ["@@", "2#", GRAY_BG],
    },
  },
  {
    name: "range replace with an end anchor rewrites every covered line",
    initial: "line one\nline two\nline three\n",
    buildEdits: (anchor) => [
      {
        end: anchor(2),
        lines: ["line uno", "line dos"],
        op: "replace",
        pos: anchor(1),
      },
    ],
    expectedFile: "line uno\nline dos\nline three\n",
    expectRender: {
      contains: [
        `${REMOVE_FG}-1 `,
        `${REMOVE_FG}-2 `,
        `${ADD_FG}+1 `,
        `${ADD_FG}+2 `,
      ],
      notContains: ["@@", "1#", "2#", GRAY_BG],
    },
  },
  {
    name: "bare append lands at the end of the file and renders green-only",
    initial: "alpha\nbeta\n",
    buildEdits: () => [{ lines: ["gamma"], op: "append" }],
    expectedFile: "alpha\nbeta\ngamma\n",
    expectRender: {
      contains: [`${ADD_FG}+3 `, "gamma"],
      notContains: [REMOVE_FG, "@@", "3#", GRAY_BG],
    },
  },
  {
    name: "prepend with pos inserts before the anchored line",
    initial: "beta\ngamma\n",
    buildEdits: (anchor) => [
      { lines: ["middle"], op: "prepend", pos: anchor(2) },
    ],
    expectedFile: "beta\nmiddle\ngamma\n",
    expectRender: {
      contains: [`${ADD_FG}+2 `, "middle"],
      notContains: [REMOVE_FG, "@@", "2#", GRAY_BG],
    },
  },
  {
    name: "partial token change tints the shared region and marks the delta",
    initial: 'const name = "alpha";\n',
    buildEdits: (anchor) => [
      { lines: ['const name = "alpine";'], op: "replace", pos: anchor(1) },
    ],
    expectedFile: 'const name = "alpine";\n',
    expectRender: {
      contains: [
        // shared prefix keeps its syntax color under the faint region tint
        `${REMOVE_FAINT_BG}${SYN_STRING}"alp`,
        `${ADD_FAINT_BG}${SYN_STRING}"alp`,
        // only the intra-token delta gets the strong inverse highlight
        `${REMOVE_FG}${INVERSE_ON}ha${INVERSE_OFF}`,
        `${ADD_FG}${INVERSE_ON}ine${INVERSE_OFF}`,
      ],
      notContains: ["@@", "1#", GRAY_BG],
    },
  },
  {
    name: "complex code edit renders every hunk with syntax-aware highlights",
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
    expectedFile: [
      'import { join } from "node:path";',
      "",
      "export const MAX_RETRIES = 5;",
      "",
      "// greet returns a warm message",
      "export function greet(name: string): string {",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture code contains template syntax
      "  return `hello ${name}`;",
      "}",
      "export default greet;",
      "",
    ].join("\n"),
    expectRender: {
      contains: [
        // three hunks: two replacements and the trailing append
        `${REMOVE_FG}-3 `,
        `${ADD_FG}+3 `,
        `${REMOVE_FG}-5 `,
        `${ADD_FG}+5 `,
        `${ADD_FG}+9 `,
        // intra-token number change is strongly highlighted
        `${REMOVE_FG}${INVERSE_ON}3${INVERSE_OFF}`,
        `${ADD_FG}${INVERSE_ON}5${INVERSE_OFF}`,
        // the shared comment prefix keeps its comment color under the tint
        `${REMOVE_FAINT_BG}${SYN_COMMENT}// greet returns a `,
        `${ADD_FAINT_BG}${SYN_COMMENT}// greet returns a `,
        `${REMOVE_FG}${INVERSE_ON}friendly${INVERSE_OFF}`,
        `${ADD_FG}${INVERSE_ON}warm${INVERSE_OFF}`,
        // untouched tokens on changed lines keep their syntax colors
        `${SYN_KEYWORD}export`,
        // an append-only hunk has no counterpart, so its tokens glow
        `${ADD_FG}${INVERSE_ON}default${INVERSE_OFF}`,
      ],
      notContains: ["@@", "3#", "5#", "9#", GRAY_BG],
    },
  },
  {
    name: "indented additions tint whitespace instead of glowing it",
    initial: "export function main(): void {\n}\n",
    buildEdits: (anchor) => [
      { lines: ["  doThing();", "}"], op: "replace", pos: anchor(2) },
    ],
    expectedFile: "export function main(): void {\n  doThing();\n}\n",
    expectRender: {
      contains: [
        `${ADD_FG}+2 `,
        // the changed indentation drops to the faint region tint
        ADD_FAINT_BG,
        // real characters still take the strong highlight
        `${ADD_FG}${INVERSE_ON}doThing${INVERSE_OFF}`,
        // the untouched closing brace collapses into a dim context row
        `${DIM} 3 `,
      ],
      notContains: [
        // the identical brace must not appear as a red/green edit row
        `${REMOVE_FG}-2 `,
        `${ADD_FG}+3 `,
        // no whitespace is ever rendered with the strong inverse highlight
        `${ADD_FG}${INVERSE_ON} `,
        `${REMOVE_FG}${INVERSE_ON} `,
        "@@",
        "2#",
        GRAY_BG,
      ],
    },
  },
  {
    name: "identical paired lines render once as dim unchanged context",
    initial: [
      "export async function fetchWithRetry(url: string): Promise<Response> {",
      "  let attempt = 0;",
      "  while (attempt < MAX_RETRIES) {",
      "    const response = await fetch(url);",
      "    if (response.ok) {",
      "      return response;",
      "    }",
      "    attempt += 1;",
      "  }",
      '  throw new Error("giving up");',
      "}",
      "",
    ].join("\n"),
    buildEdits: (anchor) => [
      {
        end: anchor(9),
        lines: [
          "  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {",
          "    const response = await fetch(url);",
          "    if (response.ok) {",
          "      return response;",
          "    }",
          "  }",
        ],
        op: "replace",
        pos: anchor(2),
      },
    ],
    expectedFile: [
      "export async function fetchWithRetry(url: string): Promise<Response> {",
      "  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {",
      "    const response = await fetch(url);",
      "    if (response.ok) {",
      "      return response;",
      "    }",
      "  }",
      '  throw new Error("giving up");',
      "}",
      "",
    ].join("\n"),
    expectRender: {
      contains: [
        // genuinely edited rows still glow
        `${REMOVE_FG}-2 `,
        `${ADD_FG}+2 `,
        `${REMOVE_FG}-8 `,
        // unchanged lines collapse into dim context rows
        `${DIM} 3 `,
        `${DIM} 4 `,
        `${DIM} 5 `,
        `${DIM} 6 `,
        `${DIM} 7 `,
      ],
      notContains: [
        // identical lines must not appear as red/green edit rows
        `${REMOVE_FG}-4 `,
        `${ADD_FG}+3 `,
        `${REMOVE_FG}-5 `,
        `${ADD_FG}+4 `,
        `${REMOVE_FG}-6 `,
        `${ADD_FG}+5 `,
        `${REMOVE_FG}-7 `,
        `${ADD_FG}+6 `,
        `${REMOVE_FG}-9 `,
        `${ADD_FG}+7 `,
        "@@",
        GRAY_BG,
      ],
    },
    checkRendered: (rendered) => {
      const plain = rendered.replace(ANSI_ESCAPE_PATTERN, "");
      const occurrences = (needle: string): number =>
        plain.split(needle).length - 1;
      // each unchanged line is rendered exactly once, not as a -/+ pair
      expect(occurrences("const response = await fetch(url);")).toBe(1);
      expect(occurrences("return response;")).toBe(1);
    },
  },
  {
    name: "hunks render sorted by line number, not by edits array order",
    initial: "one\ntwo\nthree\nfour\nfive\n",
    buildEdits: (anchor) => [
      { lines: ["FOUR"], op: "replace", pos: anchor(4) },
      { lines: ["TWO"], op: "replace", pos: anchor(2) },
    ],
    expectedFile: "one\nTWO\nthree\nFOUR\nfive\n",
    expectRender: {
      contains: [
        `${REMOVE_FG}-2 `,
        `${ADD_FG}+2 `,
        `${REMOVE_FG}-4 `,
        `${ADD_FG}+4 `,
      ],
      notContains: ["@@", "2#", "4#", GRAY_BG],
    },
    checkRendered: (rendered) => {
      const lower = rendered.indexOf(`${REMOVE_FG}-2 `);
      const higher = rendered.indexOf(`${REMOVE_FG}-4 `);
      expect(lower).toBeGreaterThanOrEqual(0);
      expect(higher).toBeGreaterThanOrEqual(0);
      expect(lower).toBeLessThan(higher);
    },
  },
  {
    name: "control characters in content are sanitized before rendering",
    initial: 'const x = "a\u0007b";\n',
    buildEdits: (anchor) => [
      { lines: ['const x = "a\u0007c";'], op: "replace", pos: anchor(1) },
    ],
    expectedFile: 'const x = "a\u0007c";\n',
    expectRender: {
      contains: [
        // cat -v style placeholder, not the raw control character
        "^G",
      ],
      notContains: [
        // raw BEL must never reach the terminal through the renderer
        "\u0007",
        "@@",
        "1#",
        GRAY_BG,
      ],
    },
  },
  {
    name: "shrinking a block renders surplus removals fully highlighted",
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
    expectedFile: [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
    ].join("\n"),
    expectRender: {
      contains: [
        `${REMOVE_FG}-2 `,
        `${REMOVE_FG}-3 `,
        `${REMOVE_FG}-4 `,
        `${ADD_FG}+2 `,
        // removed-only rows have no counterpart, so whole tokens glow
        `${REMOVE_FG}${INVERSE_ON}console${INVERSE_OFF}`,
        `${REMOVE_FG}${INVERSE_ON}return${INVERSE_OFF}`,
        `${REMOVE_FG}${INVERSE_ON}sum${INVERSE_OFF}`,
      ],
      notContains: ["@@", "2#", "3#", "4#", GRAY_BG],
    },
  },
];

const renderEditResult = (input: unknown, output: unknown): string => {
  const view = new BaseToolCallView(
    "call_1",
    "edit_file",
    theme,
    () => undefined,
    false,
    createToolRenderers()
  );
  view.setFinalInput(input);
  view.setOutput(output);
  return view.render(120).join("\n");
};

describe("edit_file hashline flow — input → file state → edit → highlight", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "pss-edit-flow-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await writeFile(join(workspace, "target.ts"), scenario.initial, "utf8");
      const tools = createWorkspaceTools({ workspace });
      const read = tools.read_file?.execute;
      const edit = tools.edit_file?.execute;
      if (typeof read !== "function" || typeof edit !== "function") {
        throw new TypeError("Expected executable read_file/edit_file tools.");
      }

      // given: the model reads the file and sees hashline anchors
      const readOutput = String(
        await read({ path: "target.ts" }, executionOptions)
      );
      const anchor = (lineNo: number): string => anchorFor(readOutput, lineNo);

      // when: the model applies the scenario's edits
      const input: Record<string, unknown> = {
        edits: scenario.buildEdits(anchor),
        path: "target.ts",
      };
      if (scenario.useExpectedFileHash === true) {
        input.expected_file_hash = fileHashOf(readOutput);
      }
      const editOutput = String(await edit(input, executionOptions));

      // then: the file on disk is exactly the expected state
      await expect(
        readFile(join(workspace, "target.ts"), "utf8")
      ).resolves.toBe(scenario.expectedFile);
      expect(editOutput).toContain("diff:");
      expect(editOutput).toContain(
        `file_hash: ${computeFileHash(scenario.expectedFile)}`
      );

      // and: the TUI renders the real tool output with the expected highlight
      const rendered = renderEditResult(input, editOutput);
      for (const expected of scenario.expectRender.contains) {
        expect(rendered).toContain(expected);
      }
      for (const forbidden of scenario.expectRender.notContains) {
        expect(rendered).not.toContain(forbidden);
      }
      scenario.checkRendered?.(rendered);
    });
  }
});
