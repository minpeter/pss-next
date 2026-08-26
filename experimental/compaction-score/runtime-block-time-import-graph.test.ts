import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const RUNTIME_BLOCK_MODULES = [
  "runtime-block-time-arm-runner",
  "runtime-block-time-instrumentation",
  "runtime-block-time-metrics",
  "runtime-block-time-runner",
  "runtime-block-time-statistics",
  "runtime-block-time-types",
  "runtime-deadline-outcome-runner",
] as const;

const LOCAL_IMPORT = /from\s+["']\.\/([^"']+)["']/g;

async function runtimeBlockImportGraph(): Promise<
  ReadonlyMap<string, readonly string[]>
> {
  const graph = new Map<string, readonly string[]>();
  await Promise.all(
    RUNTIME_BLOCK_MODULES.map(async (moduleName) => {
      const source = await readFile(
        new URL(`./${moduleName}.ts`, import.meta.url),
        "utf8"
      );
      const dependencies = [...source.matchAll(LOCAL_IMPORT)]
        .map((match) => match[1])
        .filter(
          (dependency): dependency is string =>
            dependency !== undefined &&
            RUNTIME_BLOCK_MODULES.some((candidate) => candidate === dependency)
        );
      graph.set(moduleName, dependencies);
    })
  );
  return graph;
}

function findCycle(
  graph: ReadonlyMap<string, readonly string[]>
): readonly string[] | undefined {
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];

  const visit = (moduleName: string): readonly string[] | undefined => {
    if (active.has(moduleName)) {
      const cycleStart = path.indexOf(moduleName);
      return [...path.slice(cycleStart), moduleName];
    }
    if (visited.has(moduleName)) {
      return;
    }
    visited.add(moduleName);
    active.add(moduleName);
    path.push(moduleName);
    for (const dependency of graph.get(moduleName) ?? []) {
      const cycle = visit(dependency);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    path.pop();
    active.delete(moduleName);
    return;
  };

  for (const moduleName of graph.keys()) {
    const cycle = visit(moduleName);
    if (cycle !== undefined) {
      return cycle;
    }
  }
  return;
}

describe("runtime block-time module boundaries", () => {
  it("keeps shared runtime block-time modules acyclic", async () => {
    // Given
    const graph = await runtimeBlockImportGraph();

    // When
    const cycle = findCycle(graph);

    // Then
    expect(cycle).toBeUndefined();
  });
});
