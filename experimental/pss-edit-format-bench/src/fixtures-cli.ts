import { resolve } from "node:path";
import {
  generateFixtureManifest,
  listFixtureTasks,
  loadFixtureCorpus,
  writeFixtureCorpus,
} from "./fixtures";
import { verifyWorkspace } from "./workspace";

const usage =
  "usage: fixtures-cli.ts generate <dir> [--seed N] [--count N] | check <dir> | list <dir>";

const optionValue = (
  args: readonly string[],
  name: string,
  fallback: number
): number => {
  const index = args.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const raw = args[index + 1];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
};

export const runFixtureCli = async (
  args: readonly string[]
): Promise<number> => {
  if (args[0] === "--help") {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const [command, directory] = args;
  if (command === undefined || directory === undefined) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const root = resolve(directory);
  switch (command) {
    case "generate": {
      const seed = optionValue(args, "--seed", 1);
      const count = optionValue(args, "--count", 9);
      const manifest = generateFixtureManifest(seed, count);
      await writeFixtureCorpus(root, manifest);
      process.stdout.write(
        `generated ${manifest.tasks.length} fixtures seed=${seed} at ${root}\n`
      );
      return 0;
    }
    case "check": {
      const manifest = await loadFixtureCorpus(root);
      for (const task of manifest.tasks) {
        const taskRoot = resolve(root, "tasks", task.id);
        const input = await verifyWorkspace(
          resolve(taskRoot, "input"),
          task.initialFiles,
          task.initialFiles
        );
        const expected = await verifyWorkspace(
          resolve(taskRoot, "expected"),
          task.expectedFiles,
          task.expectedFiles
        );
        const diagnostics = [
          ...input.diagnostics.map((item) => `input ${item}`),
          ...expected.diagnostics.map((item) => `expected ${item}`),
        ];
        if (diagnostics.length > 0) {
          throw new Error(
            `invalid fixture ${task.id}: ${diagnostics.join("; ")}`
          );
        }
      }
      process.stdout.write(
        `checked ${manifest.tasks.length} fixtures seed=${manifest.seed}: exact workspace files valid\n`
      );
      return 0;
    }
    case "list": {
      const manifest = await loadFixtureCorpus(root);
      process.stdout.write(`${listFixtureTasks(manifest).join("\n")}\n`);
      return 0;
    }
    default:
      process.stderr.write(`${usage}\n`);
      return 2;
  }
};

runFixtureCli(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
);
