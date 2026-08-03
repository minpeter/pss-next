import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { formatScoreCsv, scoreCampaign } from "./scoring.mjs";

async function findManifests(directory) {
  const manifests = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...(await findManifests(path)));
    } else if (entry.name === "benchmark-manifest.json") {
      manifests.push(path);
    }
  }
  return manifests;
}

async function latestCampaign(benchmarkRoot) {
  const manifests = await findManifests(
    resolve(benchmarkRoot, "results")
  ).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(
        "No benchmark campaign result was found. Run a benchmark eval first."
      );
    }
    throw error;
  });
  const dated = await Promise.all(
    manifests.map(async (path) => ({
      path,
      modified: (await stat(path)).mtimeMs,
    }))
  );
  dated.sort((left, right) => right.modified - left.modified);
  if (!dated[0]) {
    throw new Error("No benchmark campaign result was found.");
  }
  return dirname(dated[0].path);
}

/**
 * Score the given campaign directory (or the latest one under the
 * benchmark's results/) and write score.json/score.csv next to it.
 */
export async function scoreCampaignCommand({ argv, benchmarkRoot }) {
  const campaignDirectory = argv[0]
    ? resolve(process.cwd(), argv[0])
    : await latestCampaign(benchmarkRoot);
  const score = await scoreCampaign(campaignDirectory);
  const manifest = JSON.parse(
    await readFile(
      resolve(campaignDirectory, "benchmark-manifest.json"),
      "utf8"
    )
  );
  const exported = { campaignDirectory, manifest, score };
  await writeFile(
    resolve(campaignDirectory, "score.json"),
    `${JSON.stringify(exported, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    resolve(campaignDirectory, "score.csv"),
    formatScoreCsv(score),
    "utf8"
  );
  process.stdout.write(
    `Official score: ${score.passedEvals}/${score.totalEvals} (${(
      score.officialScore * 100
    ).toFixed(2)}%)\nAttempt pass rate: ${score.passedAttempts}/${
      score.totalAttempts
    } (${(score.attemptPassRate * 100).toFixed(2)}%)\nResults: ${campaignDirectory}\n`
  );
}
