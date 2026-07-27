import { execFileSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadAllFixtures,
  registerAgent,
  runExperiment,
  StartRateLimiter,
} from "@vercel/agent-eval";
import { config as loadDotenv } from "dotenv";
import { resolveNextVersion, resolveStartsPerMinute } from "./config.mjs";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  NEXTJS_EVALS_SHA,
  SMOKE_EVALS,
} from "./constants.mjs";
import { resolveBenchmarkProfile } from "./profiles.mjs";
import { createPssAgent } from "./pss-agent.mjs";

const OPTION_KEY_PATTERN = /-([a-z])/gu;
const SAFE_MODEL_PATTERN = /[^a-z0-9._-]+/giu;
const benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(benchmarkRoot, "../..");
const artifactsDirectory = resolve(benchmarkRoot, ".artifacts");
const tarballPath = resolve(artifactsDirectory, "pss-coding-agent.tgz");
loadDotenv({
  override: false,
  path: [resolve(benchmarkRoot, ".env"), resolve(repositoryRoot, ".env")],
  quiet: true,
});

function parseArguments(argv) {
  const options = {
    dryRun: false,
    filter: undefined,
    nextVersion: undefined,
    profile: "official",
    runs: undefined,
    smoke: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      options.dryRun = true;
    } else if (flag === "--smoke") {
      options.smoke = true;
    } else if (
      ["--filter", "--next-version", "--profile", "--runs"].includes(flag)
    ) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${flag} requires a value.`);
      }
      const key = flag
        .slice(2)
        .replace(OPTION_KEY_PATTERN, (_, letter) => letter.toUpperCase());
      options[key] = flag === "--runs" ? Number.parseInt(value, 10) : value;
      index += 1;
    } else {
      throw new Error(`Unknown benchmark option: ${flag}`);
    }
  }
  resolveBenchmarkProfile(options.profile);
  if (
    options.runs !== undefined &&
    (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10)
  ) {
    throw new Error("--runs must be an integer from 1 to 10.");
  }
  return options;
}

function gitSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function gitWorkingTreeDirty() {
  return (
    execFileSync("git", ["status", "--porcelain"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim().length > 0
  );
}

async function readArtifactManifest() {
  try {
    return JSON.parse(
      await readFile(resolve(artifactsDirectory, "manifest.json"), "utf8")
    );
  } catch {
    return;
  }
}

async function createSetup(nextVersion) {
  const tarball = (await readFile(tarballPath)).toString("base64");
  return async (sandbox) => {
    await sandbox.writeFiles({ ".pss-coding-agent.tgz.b64": tarball });
    const decode = await sandbox.runCommand("bash", [
      "-c",
      "base64 -d .pss-coding-agent.tgz.b64 > /tmp/pss-coding-agent.tgz && rm .pss-coding-agent.tgz.b64",
    ]);
    if (decode.exitCode !== 0) {
      throw new Error(`PSS artifact decode failed: ${decode.stderr}`);
    }
    let install;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      install = await sandbox.runCommand("npm", [
        "install",
        `next@${nextVersion}`,
        "--fetch-retries=5",
        "--fetch-retry-mintimeout=10000",
        "--fetch-retry-maxtimeout=60000",
      ]);
      if (install.exitCode === 0) {
        break;
      }
    }
    if (install.exitCode !== 0) {
      throw new Error(`Pinned Next.js install failed: ${install.stderr}`);
    }
  };
}

function selectFixtures(fixtures, options) {
  const filterNames = options.filter?.split(",").map((value) => value.trim());
  return fixtures.filter((fixture) => {
    if (options.smoke && !SMOKE_EVALS.has(fixture.name)) {
      return false;
    }
    return (
      !filterNames || filterNames.some((value) => fixture.name.includes(value))
    );
  });
}

const options = parseArguments(process.argv.slice(2));
const evalsDirectory = resolve(benchmarkRoot, "evals");
const { fixtures, errors } = loadAllFixtures(evalsDirectory, {
  validation: "vitest",
});
if (errors.length > 0) {
  throw new Error(errors.map((error) => error.message).join("\n"));
}
const selectedFixtures = selectFixtures(fixtures, options);
if (selectedFixtures.length === 0) {
  throw new Error("No eval fixtures matched the requested selection.");
}
const model =
  process.env.PSS_BENCH_MODEL ?? process.env.AI_MODEL ?? DEFAULT_MODEL;
const baseUrl = process.env.AI_BASE_URL ?? DEFAULT_BASE_URL;
const nextVersion = resolveNextVersion(options.nextVersion);
const profile = resolveBenchmarkProfile(options.profile);
const runs = options.runs ?? profile.runs;
const earlyExit = profile.earlyExit;
const artifactManifest = await readArtifactManifest();
const manifest = {
  agent: "pss",
  baseUrl,
  earlyExit,
  fixtureCount: selectedFixtures.length,
  fixtureSha: NEXTJS_EVALS_SHA,
  model,
  nextVersion,
  profile: options.profile,
  pssArtifactSha256: artifactManifest?.sha256,
  pssGitSha: gitSha(),
  pssPackageVersion: artifactManifest?.version,
  pssWorkingTreeDirty: gitWorkingTreeDirty(),
  runs,
  smoke: options.smoke,
};

if (options.dryRun) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ...manifest,
        fixtures: selectedFixtures.map((fixture) => fixture.name),
      },
      null,
      2
    )}\n`
  );
  process.exit(0);
}

await access(tarballPath);
const apiKey = process.env.AI_API_KEY;
if (!apiKey) {
  throw new Error("AI_API_KEY is required for a real benchmark run.");
}
registerAgent(createPssAgent());
let outputDirectory;
const config = {
  agent: "pss",
  model,
  evals: "*",
  runs,
  earlyExit,
  scripts: ["build"],
  validation: "vitest",
  timeout: 1200,
  setup: await createSetup(nextVersion),
  sandbox: "auto",
  copyFiles: "changed",
  agentOptions: { baseUrl },
  webResearch: false,
};
const safeModel = model.replace(SAFE_MODEL_PATTERN, "-");
const experimentName = `pss-${options.profile}/${safeModel}`;
const results = await runExperiment({
  config,
  fixtures: selectedFixtures,
  apiKey,
  resultsDir: resolve(benchmarkRoot, "results"),
  experimentName,
  smoke: options.smoke,
  rateLimiter: new StartRateLimiter(resolveStartsPerMinute(), 60_000),
  onProgress(event) {
    if (event.type === "experiment:saved") {
      outputDirectory = event.outputDir;
    }
    process.stdout.write(`${JSON.stringify(event)}\n`);
  },
});
if (!outputDirectory) {
  throw new Error("agent-eval did not report a result directory.");
}
await writeFile(
  resolve(outputDirectory, "benchmark-manifest.json"),
  `${JSON.stringify({ ...manifest, completedAt: results.completedAt }, null, 2)}\n`,
  "utf8"
);
process.stdout.write(`${JSON.stringify({ outputDirectory, manifest })}\n`);
