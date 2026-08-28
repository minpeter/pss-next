import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { CampaignCommand } from "./campaign-report";

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
    kind: z.literal("cleanup-receipt"),
    command: z.enum(["real-agent", "chaos", "profiles", "s3-faults"]),
    runId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("cleanup-check"),
    name: z.string().min(1),
    remaining: z.number().int().nonnegative(),
  }),
  z
    .object({
      kind: z.literal("cleanup-complete"),
      passed: z.boolean(),
      remaining: remainingSchema,
    })
    .superRefine((event, context) => {
      const expected = Object.values(event.remaining).every(
        (value) => value === 0
      );
      if (event.passed !== expected) {
        context.addIssue({
          code: "custom",
          message: "Cleanup passed must be derived from remaining resources.",
        });
      }
    }),
]);

export type CleanupRemaining = z.infer<typeof remainingSchema>;
export type CleanupEvent = z.infer<typeof cleanupEventSchema>;
export type CleanupCompleteEvent = Extract<
  CleanupEvent,
  { readonly kind: "cleanup-complete" }
>;
export type CleanupReceiptBinding = Extract<
  CleanupEvent,
  { readonly kind: "cleanup-receipt" }
>;

export function cleanupReceiptBinding(
  runId: string,
  command: CampaignCommand
): CleanupReceiptBinding {
  return { kind: "cleanup-receipt", runId, command };
}
export function cleanupCompleteEvent(
  remaining: CleanupRemaining
): Extract<CleanupEvent, { readonly kind: "cleanup-complete" }> {
  return {
    kind: "cleanup-complete",
    passed: Object.values(remaining).every((value) => value === 0),
    remaining,
  };
}

export function requireMeasuredCleanupPassed(
  value: boolean | undefined,
  campaign: string
): boolean {
  if (value === undefined) {
    throw new Error(`${campaign} cleanup measurement was not produced.`);
  }
  return value;
}

export async function writeCleanupReceipt(
  path: string,
  events: readonly CleanupEvent[],
  binding?: CleanupReceiptBinding
): Promise<void> {
  const parsed = events.map((event) => cleanupEventSchema.parse(event));
  const withBinding =
    binding === undefined
      ? parsed
      : [
          cleanupEventSchema.parse(binding),
          ...parsed.filter((event) => event.kind !== "cleanup-receipt"),
        ];
  const receiptBinding = withBinding[0];
  if (
    receiptBinding?.kind === "cleanup-receipt" &&
    withBinding.some(
      (event, index) => index > 0 && event.kind === "cleanup-receipt"
    )
  ) {
    throw new Error("Cleanup receipt has duplicate binding events.");
  }
  const terminal = withBinding.at(-1);
  if (terminal?.kind !== "cleanup-complete") {
    throw new Error("Cleanup receipt requires a terminal completion event.");
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const content = withBinding.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(temporary, `${content}\n`, "utf8");
  await rename(temporary, path);
}

export async function readCleanupReceipt(
  path: string
): Promise<CleanupEvent[]> {
  const content = await readFile(path, "utf8");
  const parsed = content
    .trim()
    .split("\n")
    .map((line) => cleanupEventSchema.parse(JSON.parse(line)));
  if (parsed.length === 0) {
    throw new Error("Cleanup receipt is empty.");
  }
  return parsed;
}

/*
 * Kept separate from parsing so qa:verify can require the new binding without
 * making old receipts parse as if they were authoritative evidence.
 */
export function requireCleanupReceiptBinding(
  events: readonly CleanupEvent[],
  runId: string,
  command: CampaignCommand
): void {
  const binding = events[0];
  if (
    binding?.kind !== "cleanup-receipt" ||
    binding.runId !== runId ||
    binding.command !== command
  ) {
    throw new Error("Cleanup receipt is not bound to this campaign run.");
  }
  if (
    events.some((event, index) => index > 0 && event.kind === "cleanup-receipt")
  ) {
    throw new Error("Cleanup receipt has duplicate binding events.");
  }
  const terminal = events.at(-1);
  if (terminal?.kind !== "cleanup-complete") {
    throw new Error("Cleanup receipt has no terminal event.");
  }
}

export function terminalCleanupEvent(
  events: readonly CleanupEvent[]
): CleanupCompleteEvent {
  const terminal = events.at(-1);
  if (terminal?.kind !== "cleanup-complete") {
    throw new Error("Cleanup receipt is missing a terminal cleanup event.");
  }
  return terminal;
}
