import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  getCapabilities,
  setCapabilities,
  setCellDimensions,
} from "@earendil-works/pi-tui";
import {
  extractDisplayMath,
  LatexMarkdown,
} from "../../extensions/latex/dist/latex-markdown.js";

const resultFileIndex = process.argv.indexOf("--result-file");
let result = null;
if (resultFileIndex === -1) {
  const prompt =
    process.argv.slice(2).join(" ") ||
    "페르마의 마지막 정리를 검색없이 레이텍으로 설명";
  const child = spawn(
    process.execPath,
    [
      "apps/coding-agent/bin/pss.js",
      "exec",
      "--workspace",
      process.cwd(),
      "--prompt",
      prompt,
      "--web-tools",
      "disabled",
      "--timeout-seconds",
      "300",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolveExit) => {
    child.on("close", resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(`pss exec failed (${exitCode}): ${stderr}`);
  }
  const envelope = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .findLast((event) => event.type === "result");
  result = envelope?.event ?? envelope?.result;
} else {
  const path = process.argv[resultFileIndex + 1];
  if (!path) {
    throw new Error("--result-file requires a path");
  }
  result = JSON.parse(await readFile(path, "utf8"));
}
if (typeof result?.finalText !== "string") {
  throw new Error("pss exec did not return final text");
}

const originalCapabilities = getCapabilities();
setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
setCellDimensions({ heightPx: 18, widthPx: 9 });
const plain = (text) => text;
const theme = {
  bold: plain,
  code: plain,
  codeBlock: plain,
  codeBlockBorder: plain,
  heading: plain,
  hr: plain,
  italic: plain,
  link: plain,
  linkUrl: plain,
  listBullet: plain,
  quote: plain,
  quoteBorder: plain,
  strikethrough: plain,
  underline: plain,
};
const mathParts = extractDisplayMath(result.finalText).filter(
  (part) => part.type === "math"
);
let completed = 0;
let finish;
const rendered = new Promise((resolveRender) => {
  finish = resolveRender;
});
const view = new LatexMarkdown(result.finalText, 1, 0, theme, {
  foregroundColor: process.env.PSS_TUI_FOREGROUND,
  requestRender() {
    completed += 1;
    if (completed === mathParts.length) {
      finish();
    }
  },
});
view.render(120);
if (mathParts.length > 0) {
  await Promise.race([
    rendered,
    new Promise((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(`LaTeX render timeout ${completed}/${mathParts.length}`)
          ),
        120_000
      );
    }),
  ]);
}
const lines = view.render(120);
const images = [];
for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
  const line = lines[lineIndex] ?? "";
  if (!line.includes("\x1b_Ga=T")) {
    continue;
  }
  const header = line.split("\x1b_G")[1]?.split(";")[0] ?? "";
  const rows = Number(header.match(/(?:^|,)r=([0-9]+)/)?.[1] ?? 0);
  images.push({
    columns: Number(header.match(/(?:^|,)c=([0-9]+)/)?.[1] ?? 0),
    line: lineIndex,
    margin: lines[lineIndex + rows]?.trim() === "",
    rows,
  });
}
for (const line of lines) {
  process.stdout.write(`${line}\n`);
}
process.stdout.write(
  `__PSS_QA_META__${JSON.stringify({
    formulas: mathParts.length,
    images,
    model: result.modelIds[0],
    outputTokens: result.usage.outputTokens,
  })}\n`
);
view.dispose();
setCapabilities(originalCapabilities);
