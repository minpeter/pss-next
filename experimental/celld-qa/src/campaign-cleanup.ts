import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";

const remainingSchema = z.object({
  containers: z.number().int().nonnegative(),
  ports: z.number().int().nonnegative(),
  prefixObjects: z.number().int().nonnegative(),
  processes: z.number().int().nonnegative(),
  proxyFaults: z.number().int().nonnegative(),
  watchPaths: z.number().int().nonnegative(),
});

const cleanupEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cleanup-check"),
    name: z.string().min(1),
    remaining: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("cleanup-complete"),
    passed: z.boolean(),
    remaining: remainingSchema,
  }),
]);

export type CleanupRemaining = z.infer<typeof remainingSchema>;
export type CleanupEvent = z.infer<typeof cleanupEventSchema>;

export function cleanupCompleteEvent(
  remaining: CleanupRemaining
): Extract<CleanupEvent, { readonly kind: "cleanup-complete" }> {
  return {
    kind: "cleanup-complete",
    passed: Object.values(remaining).every((value) => value === 0),
    remaining,
  };
}

export async function writeCleanupReceipt(
  path: string,
  events: readonly CleanupEvent[]
): Promise<void> {
  const parsed = events.map((event) => cleanupEventSchema.parse(event));
  const terminal = parsed.at(-1);
  if (terminal?.kind !== "cleanup-complete") {
    throw new Error("Cleanup receipt requires a terminal completion event.");
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const content = parsed.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(temporary, `${content}\n`, "utf8");
  await rename(temporary, path);
}

export async function readCleanupReceipt(
  path: string
): Promise<CleanupEvent[]> {
  const content = await readFile(path, "utf8");
  return content
    .trim()
    .split("\n")
    .map((line) => cleanupEventSchema.parse(JSON.parse(line)));
}
