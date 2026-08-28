import { z } from "zod";

export function normalizeCliArguments(
  args: readonly string[]
): readonly string[] {
  return args[0] === "--" ? args.slice(1) : args;
}

export function requiredStringOption(
  args: readonly string[],
  name: string
): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  return z.string().min(1).parse(value);
}

export function integerOption(
  args: readonly string[],
  name: string,
  fallback: number
): number {
  const index = args.indexOf(name);
  const raw = index < 0 ? undefined : args[index + 1];
  if (raw === undefined) {
    return fallback;
  }
  return z.coerce.number().int().positive().parse(raw);
}

export function csvOption(
  args: readonly string[],
  name: string
): readonly string[] {
  return requiredStringOption(args, name)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
