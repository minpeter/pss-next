import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ARG_PREFIX_PATTERN = /^--/;
const KITTY_COLUMNS_PATTERN = /(?:^|,)c=([0-9]+)/;
const KITTY_ROWS_PATTERN = /(?:^|,)r=([0-9]+)/;
const PROCESS_ID_PATTERN = /^[0-9]+$/;
const CHROME_CRASHPAD_PREFIX = "/opt/google/chrome/chrome_crashpad_handler";

const chromeCrashpadPids = () =>
  readdirSync("/proc")
    .filter((entry) => PROCESS_ID_PATTERN.test(entry))
    .filter((entry) => {
      try {
        return readFileSync(`/proc/${entry}/cmdline`, "utf8").startsWith(
          CHROME_CRASHPAD_PREFIX
        );
      } catch {
        return false;
      }
    })
    .map(Number);

const parseArgs = () => {
  const result = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    result[process.argv[index]?.replace(ARG_PREFIX_PATTERN, "")] =
      process.argv[index + 1];
  }
  return result;
};

const parseKittyLine = (line, lineIndex) => {
  if (!line.includes("\x1b_Ga=T")) {
    return { clean: line };
  }
  const commands = line.split("\x1b_G").slice(1);
  const header = commands[0]?.split(";")[0] ?? "";
  return {
    clean: line.slice(0, line.indexOf("\x1b_G")),
    image: {
      base64: commands
        .map((command) =>
          command.slice(command.indexOf(";") + 1, command.indexOf("\x1b\\"))
        )
        .join(""),
      columns: Number(header.match(KITTY_COLUMNS_PATTERN)?.[1] ?? 0),
      line: lineIndex,
      rows: Number(header.match(KITTY_ROWS_PATTERN)?.[1] ?? 0),
    },
  };
};

const stripKitty = (raw) => {
  const images = [];
  const clean = raw.split("\n").map((line, lineIndex) => {
    const parsed = parseKittyLine(line, lineIndex);
    if (parsed.image) {
      images.push(parsed.image);
    }
    return parsed.clean;
  });
  return { images, text: clean.join("\r\n") };
};

const runCommand = async (command, input, foreground) => {
  const child = spawn(command, {
    env: {
      ...process.env,
      PSS_TUI_FOREGROUND: foreground,
      TERM: "xterm-kitty",
      TERM_PROGRAM: "ghostty",
    },
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  if (input) {
    child.stdin.write(input.replaceAll("{Enter}", "\r"));
  }
  child.stdin.end();
  const exitCode = await new Promise((resolveExit) => {
    child.on("close", resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(`QA command failed (${exitCode}): ${stderr}`);
  }
  const marker = "__PSS_QA_META__";
  const metadataLine = stdout
    .split("\n")
    .find((line) => line.startsWith(marker));
  const metadata = metadataLine
    ? JSON.parse(metadataLine.slice(marker.length))
    : undefined;
  return {
    metadata,
    raw: stdout
      .split("\n")
      .filter((line) => !line.startsWith(marker))
      .join("\n"),
  };
};

const args = parseArgs();
if (!(args.command && args["evidence-dir"] && args.title)) {
  throw new Error(
    "usage: --title <title> --command <command> --input <keys> --evidence-dir <dir>"
  );
}
const evidenceDir = resolve(args["evidence-dir"]);
await mkdir(evidenceDir, { recursive: true });
const extensionRequire = createRequire(
  pathToFileURL(resolve("extensions/latex/package.json"))
);
const { chromium } = extensionRequire("playwright-core");
const xtermRoot = dirname(
  createRequire(import.meta.url).resolve("@xterm/xterm")
);
const xtermModule = resolve(xtermRoot, "xterm.mjs");
const xtermCss = resolve(xtermRoot, "../css/xterm.css");
const cases = [
  { background: "#f5f5f5", foreground: "#202020", name: "light" },
  { background: "#0d1117", foreground: "#e6edf3", name: "dark" },
];
let browser;
let server;
const results = [];
const teardown = {
  browserClosed: false,
  crashpadHandlersClosed: false,
  serverClosed: false,
  terminalDisposed: false,
};
const existingCrashpads = new Set(chromeCrashpadPids());
try {
  const outputs = [];
  for (const item of cases) {
    const output = await runCommand(args.command, args.input, item.foreground);
    const parsed = stripKitty(output.raw);
    outputs.push({
      ...item,
      ...parsed,
      metadata: output.metadata,
    });
    await writeFile(
      join(evidenceDir, `${item.name}-transcript.txt`),
      output.raw,
      "utf8"
    );
  }
  const html = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/xterm.css"><style>
body{margin:0;padding:16px;background:#111;display:flex;gap:16px;align-items:flex-start}
.case{position:relative;padding:12px}.title{font:16px sans-serif;margin-bottom:8px}
.terminal-wrap{position:relative}.formula{position:absolute;object-fit:fill;pointer-events:none}
</style><body><script type="module">
import {Terminal} from "/xterm.mjs";
const outputs=${JSON.stringify(outputs)};
for(const item of outputs){
  const section=document.createElement("section");section.className="case";
  section.style.background=item.background;
  const title=document.createElement("div");title.className="title";
  title.style.color=item.foreground;title.textContent=${JSON.stringify(args.title)}+" — "+item.name;
  const wrap=document.createElement("div");wrap.className="terminal-wrap";
  section.append(title,wrap);document.body.append(section);
  const rows=Math.max(24,item.text.split("\\r\\n").length+1);
  const terminal=new Terminal({
    cols:120,
    rows,
    fontFamily:"monospace",
    fontSize:18,
    lineHeight:1,
    theme:{background:item.background,foreground:item.foreground},
    scrollback:0
  });
  terminal.open(wrap);
  await new Promise(resolve=>terminal.write(item.text,resolve));
  await document.fonts.ready;
  const cell=terminal._core._renderService.dimensions.css.cell;
  for(const image of item.images){
    const element=document.createElement("img");element.className="formula";
    element.src="data:image/png;base64,"+image.base64;
    element.style.left=cell.width+"px";
    element.style.top=(image.line*cell.height)+"px";
    element.style.width=(image.columns*cell.width)+"px";
    element.style.height=(image.rows*cell.height)+"px";
    wrap.append(element);
  }
}
await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
window.__QA_READY__=true;
</script>`;
  server = createServer(async (request, response) => {
    if (request.url === "/xterm.mjs") {
      response.setHeader("content-type", "text/javascript");
      response.end(await readFile(xtermModule));
      return;
    }
    if (request.url === "/xterm.css") {
      response.setHeader("content-type", "text/css");
      response.end(await readFile(xtermCss));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(html);
  });
  await new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  browser = await chromium.launch({
    args: ["--disable-breakpad", "--disable-crash-reporter"],
    executablePath: "/usr/bin/google-chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { height: 1200, width: 2800 },
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => window.__QA_READY__ === true);
  for (const item of cases) {
    const section = page.locator(".case").filter({
      hasText: `— ${item.name}`,
    });
    const screenshot = join(evidenceDir, `${item.name}-xterm.png`);
    await section.screenshot({ path: screenshot });
    const metadata = outputs.find(
      (output) => output.name === item.name
    )?.metadata;
    results.push({
      background: item.background,
      foreground: item.foreground,
      formulas: metadata?.formulas ?? 0,
      margins: metadata?.images?.every((image) => image.margin) ?? false,
      name: item.name,
      screenshot,
    });
  }
  teardown.terminalDisposed = true;
} finally {
  if (browser) {
    await browser.close();
    teardown.browserClosed = true;
  }
  if (server) {
    await new Promise((resolveClose) => server.close(resolveClose));
    teardown.serverClosed = true;
  }
  for (const pid of chromeCrashpadPids()) {
    if (!existingCrashpads.has(pid)) {
      process.kill(pid);
    }
  }
  teardown.crashpadHandlersClosed = chromeCrashpadPids().every((pid) =>
    existingCrashpads.has(pid)
  );
  await writeFile(
    join(evidenceDir, "teardown.json"),
    JSON.stringify(teardown, null, 2)
  );
}
const passed = results.every((result) => result.formulas > 0 && result.margins);
await writeFile(
  join(evidenceDir, "qa-result.json"),
  JSON.stringify({ passed, results }, null, 2)
);
console.log(JSON.stringify({ evidenceDir, passed, results, teardown }));
if (!passed) {
  throw new Error("xterm visual QA failed");
}
