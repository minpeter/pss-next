import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNodeScripts } from "../src/check-scripts.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkedFiles = await checkNodeScripts({ packageRoot });
console.log(`Checked ${checkedFiles.length} Node scripts.`);
