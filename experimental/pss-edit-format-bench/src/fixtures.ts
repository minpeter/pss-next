import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { z } from "zod";
import type { WorkspaceFileSet } from "./workspace";

export type FixtureDifficulty = "easy" | "hard" | "medium";

export interface FixtureMetadata {
  readonly category: string;
  readonly contextFeatures: readonly string[];
  readonly difficulty: FixtureDifficulty;
  readonly difficultyScore: number;
  readonly language: string;
  readonly seed: number;
  readonly targetLines: readonly number[];
}

export interface FixtureTask {
  readonly expectedFiles: WorkspaceFileSet;
  readonly id: string;
  readonly initialFiles: WorkspaceFileSet;
  readonly instruction: string;
  readonly metadata: FixtureMetadata;
}

export interface FixtureManifest {
  readonly seed: number;
  readonly tasks: readonly FixtureTask[];
  readonly version: 1;
}

export const generateFixtureManifest = (
  seed: number,
  count: number
): FixtureManifest => {
  if (
    !(Number.isSafeInteger(seed) && Number.isSafeInteger(count) && count >= 1)
  ) {
    throw new Error("seed and count must be safe integers with count >= 1");
  }
  const random = createRandom(seed);
  const languages = ["typescript", "python", "rust", "go"] as const;
  const difficulties = ["easy", "medium", "hard"] as const;
  const tasks = Array.from({ length: count }, (_, index): FixtureTask => {
    const difficulty = difficulties[index % difficulties.length];
    const language = languages[index % languages.length];
    const nonce = Math.floor(random() * 1_000_000);
    const path = `src/fixture.${extensionFor(language)}`;
    const context = renderFixture(language, difficulty, nonce);
    return {
      expectedFiles: {
        [path]: context.expected,
      },
      id: `seed-${seed}-${index.toString().padStart(3, "0")}`,
      initialFiles: {
        [path]: context.initial,
      },
      instruction: `In ${path}, change only the marked target value from ${nonce} to ${nonce + 1}. Preserve every other byte.`,
      metadata: {
        category: "replace-line",
        contextFeatures: context.features,
        difficulty,
        difficultyScore: (index % difficulties.length) + 1,
        language,
        seed,
        targetLines: [context.targetLine],
      },
    };
  });
  return { seed, tasks, version: 1 };
};

export const writeFixtureCorpus = async (
  root: string,
  manifest: FixtureManifest
): Promise<void> => {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify(
      {
        seed: manifest.seed,
        taskIds: manifest.tasks.map((task) => task.id),
        version: manifest.version,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  for (const task of manifest.tasks) {
    const taskRoot = join(root, "tasks", task.id);
    const initialPaths = Object.keys(task.initialFiles).sort((left, right) =>
      left.localeCompare(right)
    );
    const expectedPaths = Object.keys(task.expectedFiles).sort((left, right) =>
      left.localeCompare(right)
    );
    await mkdir(taskRoot, { recursive: true });
    await writeFile(join(taskRoot, "prompt.txt"), task.instruction, "utf8");
    await writeFile(
      join(taskRoot, "task.json"),
      `${JSON.stringify(
        {
          expectedPaths,
          id: task.id,
          initialPaths,
          metadata: task.metadata,
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFileSet(join(taskRoot, "input"), task.initialFiles);
    await writeFileSet(join(taskRoot, "expected"), task.expectedFiles);
  }
};

export const loadFixtureCorpus = async (
  root: string
): Promise<FixtureManifest> => {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))
  );
  const tasks: FixtureTask[] = [];
  for (const id of manifest.taskIds) {
    const taskRoot = join(root, "tasks", id);
    let descriptor: z.infer<typeof taskDescriptorSchema>;
    try {
      descriptor = taskDescriptorSchema.parse(
        JSON.parse(await readFile(join(taskRoot, "task.json"), "utf8"))
      );
    } catch (error) {
      throw new Error(`invalid fixture task ${id}`, { cause: error });
    }
    if (descriptor.id !== id) {
      throw new Error(`invalid fixture task ${id}: descriptor id mismatch`);
    }
    tasks.push({
      expectedFiles: await readFileSet(
        join(taskRoot, "expected"),
        descriptor.expectedPaths
      ),
      id,
      initialFiles: await readFileSet(
        join(taskRoot, "input"),
        descriptor.initialPaths
      ),
      instruction: await readFile(join(taskRoot, "prompt.txt"), "utf8"),
      metadata: descriptor.metadata,
    });
  }
  return { seed: manifest.seed, tasks, version: 1 };
};

export const listFixtureTasks = (
  manifest: FixtureManifest
): readonly string[] =>
  manifest.tasks.map(
    (task) =>
      `${task.id} ${task.metadata.language}/${task.metadata.difficulty} ${task.metadata.category} score=${task.metadata.difficultyScore}`
  );

const metadataSchema = z
  .object({
    category: z.string().min(1),
    contextFeatures: z.array(z.string().min(1)),
    difficulty: z.enum(["easy", "medium", "hard"]),
    difficultyScore: z.number().int().min(1),
    language: z.string().min(1),
    seed: z.number().int(),
    targetLines: z.array(z.number().int().min(1)).min(1),
  })
  .strict();

const manifestSchema = z
  .object({
    seed: z.number().int(),
    taskIds: z.array(z.string().min(1)),
    version: z.literal(1),
  })
  .strict();

const taskDescriptorSchema = z
  .object({
    expectedPaths: z.array(z.string().min(1)).min(1),
    id: z.string().min(1),
    initialPaths: z.array(z.string().min(1)).min(1),
    metadata: metadataSchema,
  })
  .strict();

const createRandom = (seed: number): (() => number) => {
  let state = ((seed % 4_294_967_296) + 4_294_967_296) % 4_294_967_296;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
};

const extensionFor = (
  language: "go" | "python" | "rust" | "typescript"
): string => {
  switch (language) {
    case "go":
      return "go";
    case "python":
      return "py";
    case "rust":
      return "rs";
    case "typescript":
      return "ts";
    default:
      throw new Error(`unsupported fixture language: ${language}`);
  }
};

const renderFixture = (
  language: "go" | "python" | "rust" | "typescript",
  difficulty: FixtureDifficulty,
  value: number
): {
  readonly expected: string;
  readonly features: readonly string[];
  readonly initial: string;
  readonly targetLine: number;
} => {
  const syntax = syntaxFor(language);
  const prefix = prefixFor(difficulty, syntax);
  const suffix =
    difficulty === "hard"
      ? Array.from({ length: 20 }, (_, index) =>
          syntax.line(`nested_context_${index % 3}`, index)
        )
      : [];
  const targetLine = prefix.length + 1;
  const initial = [...prefix, syntax.line("target_value", value), ...suffix];
  const expected = [
    ...prefix,
    syntax.line("target_value", value + 1),
    ...suffix,
  ];
  const features = featuresFor(difficulty);
  return {
    expected: `${expected.join("\n")}\n`,
    features,
    initial: `${initial.join("\n")}\n`,
    targetLine,
  };
};

interface FixtureSyntax {
  readonly line: (name: string, value: number) => string;
}

const prefixFor = (
  difficulty: FixtureDifficulty,
  syntax: FixtureSyntax
): readonly string[] => {
  switch (difficulty) {
    case "easy":
      return [];
    case "medium":
      return Array.from({ length: 12 }, (_, index) =>
        syntax.line(`context_${index}`, index)
      );
    case "hard":
      return Array.from({ length: 40 }, (_, index) =>
        syntax.line(`similar_target_${index % 4}`, index)
      );
    default:
      throw new Error(`unsupported fixture difficulty: ${difficulty}`);
  }
};

const featuresFor = (difficulty: FixtureDifficulty): readonly string[] => {
  switch (difficulty) {
    case "easy":
      return ["short-context"];
    case "medium":
      return ["long-context"];
    case "hard":
      return ["long-context", "repeated-lines", "similar-blocks"];
    default:
      throw new Error(`unsupported fixture difficulty: ${difficulty}`);
  }
};

const syntaxFor = (
  language: "go" | "python" | "rust" | "typescript"
): FixtureSyntax => {
  switch (language) {
    case "go":
      return { line: (name, value) => `var ${name} = ${value}` };
    case "python":
      return { line: (name, value) => `${name} = ${value}` };
    case "rust":
      return { line: (name, value) => `let ${name} = ${value};` };
    case "typescript":
      return { line: (name, value) => `const ${name} = ${value};` };
    default:
      throw new Error(`unsupported fixture language: ${language}`);
  }
};

const safePath = (path: string): string => {
  const normalized = normalize(path);
  if (
    isAbsolute(path) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`unsafe fixture path: ${path}`);
  }
  return normalized;
};

const writeFileSet = async (
  root: string,
  files: WorkspaceFileSet
): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(root, safePath(path));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
};

const readFileSet = async (
  root: string,
  paths: readonly string[]
): Promise<WorkspaceFileSet> => {
  const files: Record<string, string> = {};
  for (const path of paths) {
    files[path] = await readFile(join(root, safePath(path)), "utf8");
  }
  return files;
};
