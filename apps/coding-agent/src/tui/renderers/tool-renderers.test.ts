import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { BaseToolCallView } from "../tool-call-view";
import { createToolRenderers } from "./tool-renderers";

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

const GRAY_BG = "\x1b[100m";
const ERROR_BG = "\x1b[48;5;88m";
const HASHLINE_ANCHOR_PATTERN = /\d+#[A-Z]+\|/;

const createView = (
  toolName: string,
  input: unknown,
  output: unknown,
  error?: unknown
): BaseToolCallView => {
  const renderers = createToolRenderers();
  const view = new BaseToolCallView(
    "call_1",
    toolName,
    theme,
    () => undefined,
    false,
    renderers
  );
  view.setFinalInput(input);
  if (output !== undefined) {
    view.setOutput(output);
  }
  if (error !== undefined) {
    view.setError(error);
  }
  return view;
};

const renderText = (view: BaseToolCallView): string =>
  view.render(120).join("\n");

describe("createToolRenderers — workspace tools", () => {
  it("read_file renders a bold header and a syntax-highlighted body without anchors", () => {
    const view = createView(
      "read_file",
      { path: "src/app.ts" },
      "OK - file\npath: src/app.ts\nfile_hash: abcd1234\nlines: 1-2/2\n1#AB|const a = 1;\n2#CD|export default a;"
    );

    const text = renderText(view);
    expect(text).toContain("read");
    expect(text).toContain("src/app.ts");
    // senpi palette truecolor: keyword const, variable a, number 1
    expect(text).toContain("\x1b[38;2;86;156;214mconst");
    expect(text).toContain("\x1b[38;2;86;156;214mexport");
    expect(text).toContain("\x1b[38;2;86;156;214mdefault");
    expect(text).toContain("\x1b[38;2;156;220;254ma");
    expect(text).toContain("\x1b[38;2;181;206;168m1");
    expect(text).not.toContain("1#AB|");
    expect(text).not.toContain("2#CD|");
    expect(text).not.toMatch(HASHLINE_ANCHOR_PATTERN);
    expect(text).not.toContain('"path"');
    expect(text).not.toContain("OK - file");
    expect(text).not.toContain("file_hash");
    expect(text).toContain(GRAY_BG);
  });

  it("read_file directory listings render without a background body", () => {
    const view = createView(
      "read_file",
      { path: "src" },
      "OK - directory\npath: src\napp.ts\nindex.ts"
    );

    const text = renderText(view);
    expect(text).toContain("read dir");
    expect(text).toContain("app.ts");
    expect(text).not.toContain(GRAY_BG);
  });

  it("write_file renders the written content, not the OK envelope", () => {
    const view = createView(
      "write_file",
      { path: "a.txt", content: "hello\nworld" },
      "OK - wrote file\npath: a.txt\nbytes: 11\nfile_hash: abcd1234"
    );

    const text = renderText(view);
    expect(text).toContain("write");
    expect(text).toContain("hello");
    expect(text).toContain("world");
    expect(text).not.toContain("OK - wrote file");
    expect(text).toContain(GRAY_BG);
  });

  it("write_file pretty-renders an empty successful write", () => {
    const view = createView(
      "write_file",
      { content: "", path: "empty.ts" },
      "OK - wrote 0 bytes to empty.ts"
    );

    const text = renderText(view);
    expect(text).toContain("write");
    expect(text).toContain("empty.ts");
    expect(text).not.toContain('"content"');
  });

  it("write_file preserves content lines that look like output headers", () => {
    const view = createView(
      "write_file",
      { content: "==== keep me\nvalue", path: "headers.txt" },
      "OK - wrote 22 bytes to headers.txt"
    );

    expect(renderText(view)).toContain("==== keep me");
  });

  it("edit_file renders a senpi-style word diff from the output diff section", () => {
    const view = createView(
      "edit_file",
      {
        path: "src/app.ts",
        edits: [{ op: "replace", pos: "121#AB", lines: "const a = 2;" }],
      },
      "OK - edited file\npath: src/app.ts\nedits: 1\nfile_hash: abcd1234\ndiff:\n@@ edit 1\n-121#SW|const a = 1;\n+121#PV|const a = 2;"
    );

    const text = renderText(view);
    expect(text).toContain("edit");
    expect(text).toContain("src/app.ts");
    // senpi scheme: red/green fg + inverse on changed words
    expect(text).toContain("\x1b[31m");
    expect(text).toContain("\x1b[32m");
    expect(text).toContain("-121");
    expect(text).toContain("+121");
    expect(text).toContain("\x1b[7m1\x1b[27m");
    expect(text).toContain("\x1b[7m2\x1b[27m");
    // syntax highlighting: keyword "const" in senpi's #569CD6 truecolor
    expect(text).toContain("\x1b[38;2;86;156;214mconst");
    // no block backgrounds or hunk markers, and no fresh anchors leak
    expect(text).not.toContain("\x1b[41m");
    expect(text).not.toContain("\x1b[42m");
    expect(text).not.toContain(GRAY_BG);
    expect(text).not.toContain("@@");
    expect(text).not.toContain("121#AB");
    expect(text).not.toContain("#PV");
    expect(text).not.toContain("#SW");
  });

  it("edit_file renders append-only diff lines in green without a red line", () => {
    const view = createView(
      "edit_file",
      { path: "src/app.ts", edits: [{ op: "append", lines: "omega();" }] },
      "OK - edited file\npath: src/app.ts\nedits: 1\nfile_hash: abcd1234\ndiff:\n@@ edit 1\n+3|omega();"
    );

    const text = renderText(view);
    expect(text).toContain("+3");
    expect(text).toContain("\x1b[32m");
    expect(text).toContain("omega");
    expect(text).not.toContain("\x1b[31m");
    expect(text).not.toContain("@@");
  });

  it("edit_file renders faint region background with strong highlight on the actual change", () => {
    const view = createView(
      "edit_file",
      {
        path: "package.json",
        edits: [
          {
            op: "replace",
            pos: "4#SW",
            lines: '  "description": "Code at the speed of thought.",',
          },
        ],
      },
      'OK - edited file\npath: package.json\nedits: 1\nfile_hash: abcd1234\ndiff:\n@@ edit 1\n-4#SW|  "description": "Code at the speed of thought",\n+4#PV|  "description": "Code at the speed of thought.",'
    );

    const text = renderText(view);
    // the touched string region gets a faint background tint
    expect(text).toContain("\x1b[48;2;61;38;40m");
    expect(text).toContain("\x1b[48;2;38;61;40m");
    // faint region keeps syntax colors inside (string #CE9178)
    expect(text).toContain("\x1b[48;2;61;38;40m\x1b[38;2;206;145;120m");
    // the actually added character "." is strongly highlighted
    expect(text).toContain("\x1b[32m\x1b[7m.\x1b[27m");
    expect(text).not.toContain("@@");
    expect(text).not.toContain("#SW");
    expect(text).not.toContain("#PV");
  });

  it("ignores a trailing empty edit group from truncated streaming output", () => {
    const input = {
      edits: [{ lines: "new", op: "replace", pos: "1#AA" }],
      path: "f.ts",
    };
    const base =
      "OK - edited f.ts\nfile_hash: 12345678\ndiff:\n@@ edit 1\n-1#AA|old\n+1#BB|new";

    const complete = createView("edit_file", input, base);
    const truncated = createView("edit_file", input, `${base}\n@@ edit 2`);

    expect(truncated.render(80).join("\n")).toBe(
      complete.render(80).join("\n")
    );
  });

  it("edit_file highlights only the edited lines in green", () => {
    const view = createView(
      "edit_file",
      {
        path: "src/app.ts",
        edits: [
          { op: "replace", pos: "1#AB", end: "2#CD", lines: "const a = 2;" },
          { op: "append", lines: "console.log(a);" },
        ],
      },
      "OK - edited file\npath: src/app.ts\nedits: 2\nfile_hash: abcd1234"
    );

    const text = renderText(view);
    expect(text).toContain("edit");
    expect(text).toContain("src/app.ts");
    expect(text).toContain("\x1b[32mconst a = 2;");
    expect(text).toContain("\x1b[32mconsole.log(a);");
    expect(text).not.toContain("@@");
    expect(text).not.toContain("1#AB");
    expect(text).not.toContain('"edits"');
  });

  it("edit_file previews array-form edit lines before output arrives", () => {
    const view = createView(
      "edit_file",
      {
        edits: [
          {
            lines: ["const a = 1;", "const b = 2;"],
            op: "replace",
            pos: "1#AA",
          },
        ],
        path: "src/example.ts",
      },
      undefined
    );

    const text = renderText(view);
    expect(text).toContain("const a = 1;");
    expect(text).toContain("const b = 2;");
  });

  it("edit_file sanitizes controls in the pre-result fallback preview", () => {
    const view = createView(
      "edit_file",
      {
        edits: [
          {
            lines: ["safe", "unsafe \u001b]52;c;cHduZWQ=\u0007\u009b31m"],
            op: "replace",
            pos: "1#AA",
          },
        ],
        path: "src/example.ts",
      },
      undefined
    );

    const text = renderText(view);
    expect(text).toContain("^[]52;c;cHduZWQ=^G\\u009b31m");
    expect(text).not.toContain("\u001b]");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\u009b");
  });

  it("delete_file renders a compact header-only block", () => {
    const view = createView(
      "delete_file",
      { path: "tmp/old.txt" },
      "OK - deleted file\npath: tmp/old.txt"
    );

    const text = renderText(view);
    expect(text).toContain("delete");
    expect(text).toContain("tmp/old.txt");
    expect(text).not.toContain("OK - deleted");
  });

  it("glob_files renders the match list without the OK header line", () => {
    const view = createView(
      "glob_files",
      { pattern: "src/**/*.ts" },
      "OK - 2 file(s)\nsrc/a.ts\nsrc/b.ts"
    );

    const text = renderText(view);
    expect(text).toContain("glob");
    expect(text).toContain("src/**/*.ts");
    expect(text).toContain("src/a.ts");
    expect(text).not.toContain("OK - 2 file(s)");
    expect(text).not.toContain(GRAY_BG);
  });

  it("grep_files renders matches with the search context in the header", () => {
    const view = createView(
      "grep_files",
      { pattern: "TODO", include: "*.ts" },
      "OK - 1 match(es)\nsrc/a.ts:3#AB|// TODO fix"
    );

    const text = renderText(view);
    expect(text).toContain("grep");
    expect(text).toContain("TODO");
    expect(text).toContain("include: *.ts");
    expect(text).toContain("// TODO fix");
    expect(text).not.toContain(GRAY_BG);
  });

  it("shell_execute renders stdout and marks non-zero exits as errors", () => {
    const okView = createView(
      "shell_execute",
      { command: "ls" },
      "OK - command finished\nexit_code: 0\nsignal: none\nstdout:\nfile-a\nstderr:\n"
    );
    const okText = renderText(okView);
    expect(okText).toContain("bash");
    expect(okText).toContain("ls");
    expect(okText).toContain("file-a");
    expect(okText).not.toContain("exit_code");
    expect(okText).not.toContain(ERROR_BG);

    const failView = createView(
      "shell_execute",
      { command: "false" },
      "OK - command finished\nexit_code: 1\nsignal: none\nstdout:\nstderr:\nboom"
    );
    const failText = renderText(failView);
    expect(failText).toContain("exit 1");
    expect(failText).toContain("boom");
    expect(failText).toContain(ERROR_BG);
  });

  it("shell_execute renders terminal controls as visible text", () => {
    const view = createView(
      "shell_execute",
      { command: "printf unsafe" },
      "OK - command finished\nexit_code: 0\nsignal: none\nstdout:\nhello \u001b]0;pwned\u0007\nstderr:\n"
    );

    const text = renderText(view);
    expect(text).toContain("^[]0;pwned^G");
    expect(text).not.toContain("\u001b]");
    expect(text).not.toContain("\u0007");
  });

  it("renders tool errors with the error background", () => {
    const view = createView(
      "read_file",
      { path: "missing.txt" },
      undefined,
      "Not a regular file: missing.txt"
    );

    const text = renderText(view);
    expect(text).toContain("read");
    expect(text).toContain("missing.txt");
    expect(text).toContain("Not a regular file");
    expect(text).toContain(ERROR_BG);
  });
});

describe("createToolRenderers — web tools", () => {
  it("web_search renders a numbered title/url/snippet list", () => {
    const view = createView("web_search", { query: "pnpm catalogs" }, [
      {
        title: "Catalogs | pnpm",
        url: "https://pnpm.io/catalogs",
        snippet: "Catalogs allow sharing versions",
        engine: "brave",
      },
    ]);

    const text = renderText(view);
    expect(text).toContain("web_search");
    expect(text).toContain("pnpm catalogs");
    expect(text).toContain("1. Catalogs | pnpm");
    expect(text).toContain("https://pnpm.io/catalogs");
    expect(text).not.toContain('"snippet"');
  });

  it("web_fetch renders per-page sections and caps long bodies", () => {
    const longText = `intro\n${"x".repeat(5000)}`;
    const view = createView("web_fetch", { urls: ["https://a.dev"] }, [
      {
        content: longText,
        length: longText.length,
        title: "Page A",
        url: "https://a.dev",
      },
    ]);

    const text = renderText(view);
    expect(text).toContain("web_fetch");
    expect(text).toContain("https://a.dev");
    expect(text).toContain("Page A");
    expect(text).toContain("intro");
    expect(text).toContain("truncated");
    expect(text.length).toBeLessThan(4000);
  });
});
