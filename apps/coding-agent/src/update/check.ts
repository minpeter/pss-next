import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { compareVersions, isValidVersion } from "./version";

export type UpdateChannel = string;

export interface UpdateCheckCache {
  readonly checkedAt: string;
  readonly tags: Readonly<Record<string, string>>;
}

export type UpdateNotice =
  | {
      readonly kind: "channel-update";
      readonly channel: UpdateChannel;
      readonly currentVersion: string;
      readonly latestVersion: string;
    }
  | {
      readonly kind: "stable-surpassed";
      readonly currentVersion: string;
      readonly latestVersion: string;
    };

export const UPDATE_CHECK_TTL_MS = 86_400_000;
const UPDATE_CHECK_CACHE_MAX_BYTES = 65_536;
const UPDATE_CHECK_CACHE_READ_FLAGS =
  constants.O_RDONLY + constants.O_NONBLOCK + constants.O_NOFOLLOW;
export const UPDATE_CHECK_CACHE_FILENAME = "update-check.json";
export const CODING_AGENT_PACKAGE_NAME = "@minpeter/pss-coding-agent";
export const DEFAULT_REGISTRY_BASE_URL = "https://registry.npmjs.org";

export interface RegistryFetchResponse {
  json(): Promise<unknown>;
  readonly ok: boolean;
}

export type RegistryFetch = (
  url: string,
  init: { signal: AbortSignal }
) => Promise<RegistryFetchResponse>;

export interface FetchDistTagsOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: RegistryFetch;
  readonly timeoutMs?: number;
}

export function isCacheFresh(
  cache: UpdateCheckCache,
  now: number,
  ttlMs: number = UPDATE_CHECK_TTL_MS
): boolean {
  const age = now - Date.parse(cache.checkedAt);
  return age >= 0 && age < ttlMs;
}

export function decideUpdateNotice(
  current: { version: string; channel: UpdateChannel },
  tags: Readonly<Record<string, string>>
): UpdateNotice | undefined {
  const channelTag = tags[current.channel];
  if (
    channelTag !== undefined &&
    isValidVersion(channelTag) &&
    compareVersions(channelTag, current.version) > 0
  ) {
    return {
      kind: "channel-update",
      channel: current.channel,
      currentVersion: current.version,
      latestVersion: channelTag,
    };
  }

  if (current.channel !== "latest") {
    const stableTag = tags.latest;
    if (
      stableTag !== undefined &&
      isValidVersion(stableTag) &&
      compareVersions(stableTag, current.version) > 0
    ) {
      return {
        kind: "stable-surpassed",
        currentVersion: current.version,
        latestVersion: stableTag,
      };
    }
  }

  return;
}

export function formatUpdateNotice(notice: UpdateNotice): string {
  switch (notice.kind) {
    case "channel-update":
      return `update available: ${notice.currentVersion} -> ${notice.latestVersion} - run "pss update"`;
    case "stable-surpassed":
      return `stable ${notice.latestVersion} is available (you have ${notice.currentVersion}) - run "pss update --channel latest"`;
    default:
      return assertNever(notice);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected update notice: ${JSON.stringify(value)}`);
}

const updateCheckCacheSchema = z.object({
  checkedAt: z.string().min(1),
  tags: z.record(z.string().min(1), z.string().min(1)),
});

export function parseUpdateCheckCache(
  text: string
): UpdateCheckCache | undefined {
  try {
    const parsed = updateCheckCacheSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}

export async function readUpdateCheckCache(
  path: string
): Promise<UpdateCheckCache | undefined> {
  try {
    const handle = await open(path, UPDATE_CHECK_CACHE_READ_FLAGS);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > UPDATE_CHECK_CACHE_MAX_BYTES) {
        return;
      }

      const buffer = Buffer.allocUnsafe(UPDATE_CHECK_CACHE_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length
        );
        if (bytesRead === 0) {
          break;
        }
        length += bytesRead;
      }
      if (length > UPDATE_CHECK_CACHE_MAX_BYTES) {
        return;
      }
      return parseUpdateCheckCache(buffer.toString("utf8", 0, length));
    } finally {
      await handle.close();
    }
  } catch {
    return;
  }
}

export async function writeUpdateCheckCache(
  path: string,
  cache: UpdateCheckCache
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  const temporaryPath = join(
    directory,
    `.${UPDATE_CHECK_CACHE_FILENAME}.${process.pid}.${randomUUID()}.tmp`
  );
  await writeFile(temporaryPath, `${JSON.stringify(cache)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export async function fetchDistTags({
  baseUrl = DEFAULT_REGISTRY_BASE_URL,
  fetchImpl = defaultRegistryFetch,
  timeoutMs = 3000,
}: FetchDistTagsOptions = {}): Promise<Readonly<Record<string, string>>> {
  const url = `${baseUrl}/${encodeURIComponent(CODING_AGENT_PACKAGE_NAME)}`;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {};
    }

    const payload: unknown = await response.json();
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("dist-tags" in payload)
    ) {
      return {};
    }

    const distTags = payload["dist-tags"];
    if (typeof distTags !== "object" || distTags === null) {
      return {};
    }

    const entries: [string, string][] = [];
    for (const [tag, version] of Object.entries(distTags)) {
      if (tag === "" || encodeURIComponent(tag) !== tag) {
        continue;
      }
      if (typeof version === "string" && isValidVersion(version)) {
        entries.push([tag, version]);
      }
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function publishedTagVersion(
  tags: Readonly<Record<string, string>>,
  channel: string
): string | undefined {
  return Object.hasOwn(tags, channel) ? tags[channel] : undefined;
}

const defaultRegistryFetch: RegistryFetch = (url, init) => fetch(url, init);

export function resolveUpdateRegistryBaseUrl(env: NodeJS.ProcessEnv): string {
  const override = env.PSS_UPDATE_REGISTRY_BASE_URL?.trim();
  return override === undefined || override === ""
    ? DEFAULT_REGISTRY_BASE_URL
    : override;
}
